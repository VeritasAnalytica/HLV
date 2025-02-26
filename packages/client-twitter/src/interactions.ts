import { SearchMode, Tweet } from "agent-twitter-client";
import {
    composeContext,
    generateMessageResponse,
    generateShouldRespond,
    messageCompletionFooter,
    shouldRespondFooter,
    Content,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    stringToUuid,
    elizaLogger,
    getEmbeddingZeroVector,
    truncateToCompleteSentence,
} from "@elizaos/core";
import { ClientBase } from "./base";
import { buildConversationThread, sendTweet, wait } from "./utils.ts";

// Templates for generating a tweet reply and for deciding whether to respond
export const twitterMessageHandlerTemplate =
    `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

# Relevant Lottery News:
{{newsContext}}

# TASK: Generate a post/reply in the voice, style, and perspective of {{agentName}} (@{{twitterUserName}}).
- If relevant, incorporate the latest lottery news into your response.
- Keep the response concise and engaging.
- Do not include URLs unless explicitly asked.

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}` + messageCompletionFooter;

export const twitterShouldRespondTemplate = (targetUsersStr: string) =>
    `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "true" or "false".

Response options are RESPOND, IGNORE and STOP.

PRIORITY RULE: ALWAYS RESPOND to these users regardless of topic or message content: ${targetUsersStr}. Topic relevance should be ignored for these users.

For other users:
- {{agentName}} should RESPOND to messages directed at them
- {{agentName}} should RESPOND to conversations relevant to their background
- {{agentName}} should IGNORE irrelevant messages
- {{agentName}} should IGNORE very short messages unless directly addressed
- {{agentName}} should STOP if asked to stop
- {{agentName}} should STOP if conversation is concluded
- {{agentName}} is in a room with other users and wants to be conversational, but not annoying.

IMPORTANT:
- {{agentName}} (aka @{{twitterUserName}}) is particularly sensitive about being annoying, so if there is any doubt, it is better to IGNORE than to RESPOND.
- For users not in the priority list, {{agentName}} (@{{twitterUserName}}) should err on the side of IGNORE rather than RESPOND if in doubt.

Recent Posts:
{{recentPosts}}

Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# INSTRUCTIONS: Respond with [RESPOND] if {{agentName}} should respond, or [IGNORE] if {{agentName}} should not respond to the last message and [STOP] if {{agentName}} should stop participating in the conversation.
` + shouldRespondFooter;

// --------------------
// Discord-related imports and helper types
// --------------------
import {
    Client as DiscordClient,
    GatewayIntentBits,
    Partials,
    TextChannel,
    Events,
} from "discord.js";

// Define the structure for a pending reply awaiting approval
interface PendingReply {
    cleanedContent: string;
    roomId: string;
    newReplyContent: string;
    discordMessageId: string;
    channelId: string;
    timestamp: number;
    inReplyToTweetId: string;
}

// --------------------
// TwitterInteractionClient with Reply Approval via Discord
// --------------------
export class TwitterInteractionClient {
    client: ClientBase;
    private readonly LUNAR_CRUSH_API_KEY =
        "fe86qpt128h60sv2g8jysc6qffm6eckvitbd8f0q";
    runtime: IAgentRuntime;

    // Discord approval properties
    approvalRequired: boolean = false;
    discordClientForApproval?: DiscordClient;
    discordApprovalChannelId?: string;
    approvalCheckInterval: number = 5 * 60 * 1000; // Default: 5 minutes

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;

        // Check if tweet approval is enabled via runtime settings
        const approvalSetting =
            this.runtime
                .getSetting("TWITTER_APPROVAL_ENABLED")
                ?.toLowerCase() === "true";
        if (approvalSetting) {
            const discordToken = this.runtime.getSetting(
                "TWITTER_APPROVAL_DISCORD_BOT_TOKEN"
            );
            const approvalChannelId = this.runtime.getSetting(
                "TWITTER_APPROVAL_DISCORD_CHANNEL_ID"
            );
            const intervalSetting =
                parseInt(
                    this.runtime.getSetting("TWITTER_APPROVAL_CHECK_INTERVAL")
                ) || 5 * 60 * 1000;
            if (!discordToken || !approvalChannelId) {
                throw new Error(
                    "TWITTER_APPROVAL_DISCORD_BOT_TOKEN and TWITTER_APPROVAL_DISCORD_CHANNEL_ID are required for the approval workflow"
                );
            }
            this.approvalRequired = true;
            this.discordApprovalChannelId = approvalChannelId;
            this.approvalCheckInterval = intervalSetting;
            this.setupDiscordClient();
        }
    }

    // Set up the Discord client for approval workflow
    private setupDiscordClient() {
        this.discordClientForApproval = new DiscordClient({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMessageReactions,
            ],
            partials: [Partials.Channel, Partials.Message, Partials.Reaction],
        });
        this.discordClientForApproval.once(
            Events.ClientReady,
            (readyClient) => {
                elizaLogger.log(
                    `Discord bot is ready as ${readyClient.user?.tag || "unknown"}!`
                );
            }
        );
        this.discordClientForApproval.login(
            this.runtime.getSetting("TWITTER_APPROVAL_DISCORD_BOT_TOKEN")
        );
    }

    // Start the Twitter interactions loop (polling for new mentions/tweets)
    async start() {
        const handleTwitterInteractionsLoop = () => {
            this.handleTwitterInteractions();
            setTimeout(
                handleTwitterInteractionsLoop,
                this.client.twitterConfig.TWITTER_POLL_INTERVAL * 1000 // Defaults to 2 minutes if configured so
            );
        };
        handleTwitterInteractionsLoop();

        // If approval is enabled, start checking pending replies
        if (this.approvalRequired) {
            this.runPendingRepliesCheckLoop();
        }
    }

    // Main method to check for Twitter interactions (mentions and target-user tweets)
    async handleTwitterInteractions() {
        elizaLogger.log("Checking Twitter interactions");

        const twitterUsername = this.client.profile.username;
        try {
            // Fetch tweets that mention the bot
            const mentionCandidates = (
                await this.client.fetchSearchTweets(
                    `@${twitterUsername}`,
                    50,
                    SearchMode.Latest
                )
            ).tweets;

            elizaLogger.log(
                "Completed checking mentioned tweets:",
                mentionCandidates.length
            );
            let uniqueTweetCandidates = [...mentionCandidates];

            // If target users are configured, fetch additional tweets from them
            if (this.client.twitterConfig.TWITTER_TARGET_USERS.length) {
                const TARGET_USERS =
                    this.client.twitterConfig.TWITTER_TARGET_USERS;

                elizaLogger.log("Processing target users:", TARGET_USERS);

                if (TARGET_USERS.length > 0) {
                    // Create a map to store tweets by user
                    const tweetsByUser = new Map<string, Tweet[]>();

                    // Fetch tweets from each target user
                    for (const username of TARGET_USERS) {
                        try {
                            const userTweets = (
                                await this.client.twitterClient.fetchSearchTweets(
                                    `from:${username}`,
                                    20,
                                    SearchMode.Latest
                                )
                            ).tweets;

                            // Filter for unprocessed, non-reply, recent tweets
                            const validTweets = userTweets.filter((tweet) => {
                                const isUnprocessed =
                                    !this.client.lastCheckedTweetId ||
                                    parseInt(tweet.id) >
                                        this.client.lastCheckedTweetId;
                                const isRecent =
                                    Date.now() - tweet.timestamp * 1000 <
                                    2 * 60 * 60 * 1000;

                                elizaLogger.log(`Tweet ${tweet.id} checks:`, {
                                    isUnprocessed,
                                    isRecent,
                                    isReply: tweet.isReply,
                                    isRetweet: tweet.isRetweet,
                                });

                                return (
                                    isUnprocessed &&
                                    !tweet.isReply &&
                                    !tweet.isRetweet &&
                                    isRecent
                                );
                            });

                            if (validTweets.length > 0) {
                                tweetsByUser.set(username, validTweets);
                                elizaLogger.log(
                                    `Found ${validTweets.length} valid tweets from ${username}`
                                );
                            }
                        } catch (error) {
                            elizaLogger.error(
                                `Error fetching tweets for ${username}:`,
                                error
                            );
                            continue;
                        }
                    }

                    // Select one tweet from each target user (if available)
                    const selectedTweets: Tweet[] = [];
                    for (const [username, tweets] of tweetsByUser) {
                        if (tweets.length > 0) {
                            const randomTweet =
                                tweets[
                                    Math.floor(Math.random() * tweets.length)
                                ];
                            selectedTweets.push(randomTweet);
                            elizaLogger.log(
                                `Selected tweet from ${username}: ${randomTweet.text?.substring(
                                    0,
                                    100
                                )}`
                            );
                        }
                    }

                    // Combine mentions and target-user tweets
                    uniqueTweetCandidates = [
                        ...mentionCandidates,
                        ...selectedTweets,
                    ];
                }
            } else {
                elizaLogger.log(
                    "No target users configured, processing only mentions"
                );
            }

            // Sort candidates by tweet ID (ascending) and filter out tweets from the bot itself
            uniqueTweetCandidates
                .sort((a, b) => a.id.localeCompare(b.id))
                .filter((tweet) => tweet.userId !== this.client.profile.id);

            // Process each candidate tweet
            for (const tweet of uniqueTweetCandidates) {
                if (
                    !this.client.lastCheckedTweetId ||
                    BigInt(tweet.id) > this.client.lastCheckedTweetId
                ) {
                    const tweetId = stringToUuid(
                        tweet.id + "-" + this.runtime.agentId
                    );

                    // Check if this tweet has already been processed
                    const existingResponse =
                        await this.runtime.messageManager.getMemoryById(
                            tweetId
                        );
                    if (existingResponse) {
                        elizaLogger.log(
                            `Already responded to tweet ${tweet.id}, skipping`
                        );
                        continue;
                    }
                    elizaLogger.log("New Tweet found", tweet.permanentUrl);

                    const roomId = stringToUuid(
                        tweet.conversationId + "-" + this.runtime.agentId
                    );

                    // Create a connection between the bot and the tweet’s author (if not already done)
                    const userIdUUID =
                        tweet.userId === this.client.profile.id
                            ? this.runtime.agentId
                            : stringToUuid(tweet.userId!);

                    await this.runtime.ensureConnection(
                        userIdUUID,
                        roomId,
                        tweet.username,
                        tweet.name,
                        "twitter"
                    );

                    // Build the conversation thread for context
                    const thread = await buildConversationThread(
                        tweet,
                        this.client
                    );

                    const message: Memory = {
                        content: { text: tweet.text },
                        agentId: this.runtime.agentId,
                        userId: userIdUUID,
                        roomId,
                    };

                    // Handle the tweet (reply, ignore, or stop)
                    await this.handleTweet({
                        tweet,
                        message,
                        thread,
                    });

                    // Update the last checked tweet ID after processing each tweet
                    this.client.lastCheckedTweetId = BigInt(tweet.id);
                }
            }

            // Save the latest checked tweet ID to the cache/file
            await this.client.cacheLatestCheckedTweetId();

            elizaLogger.log("Finished checking Twitter interactions");
        } catch (error) {
            elizaLogger.error("Error handling Twitter interactions:", error);
        }
    }

    private async fetchNewsFromLunarCrush(): Promise<any[]> {
        try {
            const response = await fetch(
                "https://lunarcrush.com/api4/public/topic/Lottery/news/v1",
                {
                    headers: {
                        Authorization: `Bearer ${this.LUNAR_CRUSH_API_KEY}`,
                    },
                }
            );

            if (!response.ok) {
                throw new Error(`LunarCrush API error: ${response.statusText}`);
            }

            const newsData = await response.json();
            return (
                newsData.data?.slice(0, 5).map((news: any) => ({
                    title: news.title,
                    url: news.url,
                    image: news.image,
                    description: news.description,
                    source: news.source,
                })) || []
            );
        } catch (error) {
            elizaLogger.error("Error fetching LunarCrush news:", error);
            return [];
        }
    }

    // Process an individual tweet candidate
    private async handleTweet({
        tweet,
        message,
        thread,
    }: {
        tweet: Tweet;
        message: Memory;
        thread: Tweet[];
    }) {
        // Skip tweets from the bot itself or tweets with no text
        if (tweet.userId === this.client.profile.id) {
            return;
        }
        if (!message.content.text) {
            elizaLogger.log("Skipping Tweet with no text", tweet.id);
            return { text: "", action: "IGNORE" };
        }

        elizaLogger.log("Processing Tweet: ", tweet.id);
        const formatTweet = (tweet: Tweet) => {
            return `  ID: ${tweet.id}
  From: ${tweet.name} (@${tweet.username})
  Text: ${tweet.text}`;
        };
        const currentPost = formatTweet(tweet);

        elizaLogger.debug("Thread: ", thread);
        const formattedConversation = thread
            .map(
                (tweet) =>
                    `@${tweet.username} (${new Date(
                        tweet.timestamp * 1000
                    ).toLocaleString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                        month: "short",
                        day: "numeric",
                    })}):\n${tweet.text}`
            )
            .join("\n\n");

        elizaLogger.debug("formattedConversation: ", formattedConversation);

        // Fetch news from LunarCrush
        const newsItems = await this.fetchNewsFromLunarCrush();
        const newsContext =
            newsItems.length > 0
                ? "Latest Lottery News:\n" +
                  newsItems
                      .slice(0, 3)
                      .map(
                          (item, idx) =>
                              `${idx + 1}. ${item.title} (${item.url})`
                      )
                      .join("\n")
                : "No recent lottery news available";

        // Compose state for generating a response
        let state = await this.runtime.composeState(message, {
            twitterClient: this.client.twitterClient,
            twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
            currentPost,
            formattedConversation,
            newsContext, // Add news context here
        });

        // Save the tweet in memory if it has not been saved yet
        const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
        const tweetExists =
            await this.runtime.messageManager.getMemoryById(tweetId);
        if (!tweetExists) {
            elizaLogger.log("Tweet does not exist, saving");
            const userIdUUID = stringToUuid(tweet.userId as string);
            const roomId = stringToUuid(tweet.conversationId);
            const messageToSave: Memory = {
                id: tweetId,
                agentId: this.runtime.agentId,
                content: {
                    text: tweet.text,
                    url: tweet.permanentUrl,
                    inReplyTo: tweet.inReplyToStatusId
                        ? stringToUuid(
                              tweet.inReplyToStatusId +
                                  "-" +
                                  this.runtime.agentId
                          )
                        : undefined,
                },
                userId: userIdUUID,
                roomId,
                createdAt: tweet.timestamp * 1000,
            };
            this.client.saveRequestMessage(messageToSave, state);
        }

        // Build the "should respond" context using the target users list
        const validTargetUsersStr =
            this.client.twitterConfig.TWITTER_TARGET_USERS.join(",");
        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.twitterShouldRespondTemplate ||
                this.runtime.character?.templates?.shouldRespondTemplate ||
                twitterShouldRespondTemplate(validTargetUsersStr),
        });
        const shouldRespond = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.MEDIUM,
        });
        if (shouldRespond !== "RESPOND") {
            elizaLogger.log("Not responding to message");
            return { text: "Response Decision:", action: shouldRespond };
        }

        // Build the response context for generating the tweet reply
        const context = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.twitterMessageHandlerTemplate ||
                this.runtime.character?.templates?.messageHandlerTemplate ||
                twitterMessageHandlerTemplate,
        });

        elizaLogger.debug("Interactions prompt:\n" + context);
        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        // --- Updated tweet content cleaning and URL concatenation ---
        const removeQuotes = (str: string) =>
            str.replace(/^['"](.*)['"]$/, "$1");
        const fixNewLines = (str: string) => str.replaceAll(/\\n/g, "\n\n");

        let tweetContent = removeQuotes(response.text).trim();

        // Define the boost lottery URL and calculate available space for content
        const boostLotteryUrl = "https://boostlottery.io";
        const maxTweetLength = this.client.twitterConfig.MAX_TWEET_LENGTH;
        const urlLength = boostLotteryUrl.length;
        const spaceBetween = 1; // Space between content and URL
        const maxContentLength = maxTweetLength - urlLength - spaceBetween;

        // Clean up and truncate the tweet content if necessary
        tweetContent = removeQuotes(fixNewLines(tweetContent)).trim();
        if (maxContentLength > 0) {
            tweetContent = truncateToCompleteSentence(
                tweetContent,
                maxContentLength
            );
        }
        // Append the URL ensuring a space separates the text and URL
        tweetContent = `${tweetContent} ${boostLotteryUrl}`;

        response.text = tweetContent;
        elizaLogger.debug("Final tweet text with URL:", response.text);
        // --- End of URL concatenation update ---

        // ----- NEW: Approval workflow for tweet replies -----
        if (this.approvalRequired) {
            // Instead of posting immediately, send the reply for approval.
            // In TwitterInteractionClient's handleTweet method

            // const testContent = "Test reply from BOOST Lottery 🎟️";

            const discordMessageId = await this.sendReplyForApproval(
                response.text,
                message.roomId,
                response.text,
                tweet.id,
                tweet.username // Add original tweet's username
            );

        //    const discordMessageId = await this.sendReplyForApproval(
        //        testContent,
        //        "test-room",
        //        testContent,
        //        "12345",
        //        "user"
        //    );

            if (discordMessageId) {
                elizaLogger.log(
                    "Reply sent for approval. Discord message ID:",
                    discordMessageId
                );
            }
            // Do not post the reply immediately—exit here.
            return;
        }
        // ----- END NEW: Approval workflow -----

        // If approval is not required, post the reply immediately.
        try {
            const callback: HandlerCallback = async (response: Content) => {
                const memories = await sendTweet(
                    this.client,
                    response,
                    message.roomId,
                    this.client.twitterConfig.TWITTER_USERNAME,
                    tweet.id
                );
                return memories;
            };

            const responseMessages = await callback(response);
            state = (await this.runtime.updateRecentMessageState(
                state
            )) as State;
            for (const responseMessage of responseMessages) {
                if (
                    responseMessage ===
                    responseMessages[responseMessages.length - 1]
                ) {
                    responseMessage.content.action = response.action;
                } else {
                    responseMessage.content.action = "CONTINUE";
                }
                await this.runtime.messageManager.createMemory(responseMessage);
            }
            await this.runtime.processActions(
                message,
                responseMessages,
                state,
                callback
            );

            const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;
            await this.runtime.cacheManager.set(
                `twitter/tweet_generation_${tweet.id}.txt`,
                responseInfo
            );
            await wait();
        } catch (error) {
            elizaLogger.error(`Error sending response tweet: ${error}`);
        }
    }

    // Send the generated tweet reply to Discord for approval
    // In your sendReplyForApproval function:
    private async sendReplyForApproval(
        cleanedContent: string,
        roomId: string,
        newReplyContent: string,
        inReplyToTweetId: string,
        originalUsername: string // New parameter for original tweet's username
    ): Promise<string | null> {
        try {


            const embed = {
                title: "New Tweet Reply Pending Approval",
                description: cleanedContent,
                fields: [
                    {
                        name: "Character",
                        value: this.client.profile.username,
                        inline: true,
                    },
                    {
                        name: "Replying To",

                        // Create proper Twitter URL using username and ID
                        value: `https://twitter.com/${originalUsername}/status/${inReplyToTweetId}`,
                        inline: true,
                    },
                    // {
                    //     name: "Replying To",

                    //     // Create proper Twitter URL using username and ID
                    //     value: `jomolopo`,
                    //     inline: true,
                    // },
                    {
                        name: "Length",
                        value: cleanedContent.length.toString(),
                        inline: true,
                    },
                ],
                footer: {
                    text: "Reply with '😂' to post or '❌' to discard. This request will expire after 24 hours if no response is received.",
                },
                timestamp: new Date().toISOString(),
            };

            if (
                !this.discordClientForApproval ||
                !this.discordApprovalChannelId
            ) {
                throw new Error(
                    "Discord client or approval channel not configured"
                );
            }

            const channel = await this.discordClientForApproval.channels.fetch(
                this.discordApprovalChannelId
            );
            if (!channel || !(channel instanceof TextChannel)) {
                throw new Error("Invalid approval channel");
            }
            const message = await channel.send({ embeds: [embed] });

            // Save pending reply details in cache
            const pendingRepliesKey = `twitter/${this.client.profile.username}/pendingReply`;
            const currentPendingReplies =
                (await this.runtime.cacheManager.get<PendingReply[]>(
                    pendingRepliesKey
                )) || [];
            currentPendingReplies.push({
                cleanedContent,
                roomId,
                newReplyContent,
                discordMessageId: message.id,
                channelId: this.discordApprovalChannelId,
                timestamp: Date.now(),
                inReplyToTweetId,
            });
            await this.runtime.cacheManager.set(
                pendingRepliesKey,
                currentPendingReplies
            );
            return message.id;
        } catch (error) {
            elizaLogger.error(
                "Error sending tweet reply approval request:",
                error
            );
            return null;
        }
    }

    // Check the approval status of a Discord message by its ID.
    // Returns "APPROVED", "REJECTED", or "PENDING".
    private async checkApprovalStatus(
        discordMessageId: string
    ): Promise<"PENDING" | "APPROVED" | "REJECTED"> {
        try {
            if (
                !this.discordClientForApproval ||
                !this.discordApprovalChannelId
            ) {
                elizaLogger.error(
                    "Discord client or approval channel not configured"
                );
                return "PENDING";
            }
            const channel = await this.discordClientForApproval.channels.fetch(
                this.discordApprovalChannelId
            );
            if (!(channel instanceof TextChannel)) {
                elizaLogger.error("Invalid approval channel");
                return "PENDING";
            }
            const message = await channel.messages.fetch(discordMessageId);
            const thumbsUpReaction = message.reactions.cache.find(
                (reaction) => reaction.emoji.name === "😂"
            );
            const rejectReaction = message.reactions.cache.find(
                (reaction) => reaction.emoji.name === "                 "
            );
            if (rejectReaction && rejectReaction.count > 0) {
                return "REJECTED";
            }
            if (thumbsUpReaction && thumbsUpReaction.count > 0) {
                return "APPROVED";
            }
            return "PENDING";
        } catch (error) {
            elizaLogger.error("Error checking approval status:", error);
            return "PENDING";
        }
    }

    // Remove a pending reply entry from the cache by its Discord message ID
    private async cleanupPendingReply(discordMessageId: string) {
        const pendingRepliesKey = `twitter/${this.client.profile.username}/pendingReply`;
        const currentPendingReplies =
            (await this.runtime.cacheManager.get<PendingReply[]>(
                pendingRepliesKey
            )) || [];
        const updatedPendingReplies = currentPendingReplies.filter(
            (reply) => reply.discordMessageId !== discordMessageId
        );
        if (updatedPendingReplies.length === 0) {
            await this.runtime.cacheManager.delete(pendingRepliesKey);
        } else {
            await this.runtime.cacheManager.set(
                pendingRepliesKey,
                updatedPendingReplies
            );
        }
    }

    // Check all pending tweet replies for approval status and post them if approved
    private async handlePendingReplies() {
        elizaLogger.log("Checking pending replies...");
        const pendingRepliesKey = `twitter/${this.client.profile.username}/pendingReply`;
        const pendingReplies =
            (await this.runtime.cacheManager.get<PendingReply[]>(
                pendingRepliesKey
            )) || [];
        for (const pendingReply of pendingReplies) {
            // Expire any pending reply older than 24 hours
            const isExpired =
                Date.now() - pendingReply.timestamp > 24 * 60 * 60 * 1000;
            if (isExpired) {
                elizaLogger.log("Pending reply expired, cleaning up");
                try {
                    if (this.discordClientForApproval) {
                        const channel =
                            await this.discordClientForApproval.channels.fetch(
                                pendingReply.channelId
                            );
                        if (channel instanceof TextChannel) {
                            const originalMessage =
                                await channel.messages.fetch(
                                    pendingReply.discordMessageId
                                );
                            await originalMessage.reply(
                                "This tweet reply approval request has expired (24h timeout)."
                            );
                        }
                    }
                } catch (error) {
                    elizaLogger.error(
                        "Error sending expiration notification:",
                        error
                    );
                }
                await this.cleanupPendingReply(pendingReply.discordMessageId);
                continue;
            }

            // Check approval status on Discord
            const approvalStatus = await this.checkApprovalStatus(
                pendingReply.discordMessageId
            );
            if (approvalStatus === "APPROVED") {
                elizaLogger.log(
                    "Reply approved, posting reply for tweet ID:",
                    pendingReply.inReplyToTweetId
                );
                try {
                    const content: Content = {
                        text: pendingReply.newReplyContent,
                    };
                    // Post the reply tweet by calling sendTweet with the inReplyToTweetId
                    await sendTweet(
                        this.client,
                        content,
                        stringToUuid(pendingReply.roomId),
                        this.client.twitterConfig.TWITTER_USERNAME,
                        pendingReply.inReplyToTweetId
                    );
                    elizaLogger.log("Reply posted successfully.");
                } catch (error) {
                    elizaLogger.error("Error posting approved reply:", error);
                }
                try {
                    if (this.discordClientForApproval) {
                        const channel =
                            await this.discordClientForApproval.channels.fetch(
                                pendingReply.channelId
                            );
                        if (channel instanceof TextChannel) {
                            const originalMessage =
                                await channel.messages.fetch(
                                    pendingReply.discordMessageId
                                );
                            await originalMessage.reply(
                                "Reply has been posted successfully! ✅"
                            );
                        }
                    }
                } catch (error) {
                    elizaLogger.error(
                        "Error sending post notification:",
                        error
                    );
                }
                await this.cleanupPendingReply(pendingReply.discordMessageId);
            } else if (approvalStatus === "REJECTED") {
                elizaLogger.log("Reply rejected, cleaning up");
                await this.cleanupPendingReply(pendingReply.discordMessageId);
                try {
                    if (this.discordClientForApproval) {
                        const channel =
                            await this.discordClientForApproval.channels.fetch(
                                pendingReply.channelId
                            );
                        if (channel instanceof TextChannel) {
                            const originalMessage =
                                await channel.messages.fetch(
                                    pendingReply.discordMessageId
                                );
                            await originalMessage.reply(
                                "Reply has been rejected! ❌"
                            );
                        }
                    }
                } catch (error) {
                    elizaLogger.error(
                        "Error sending rejection notification:",
                        error
                    );
                }
            }
        }
    }

    // Set up an interval to periodically check pending tweet replies for approval
    private runPendingRepliesCheckLoop() {
        setInterval(async () => {
            await this.handlePendingReplies();
        }, this.approvalCheckInterval);
    }

    // Build the conversation thread (from the tweet and its parent tweets)
    async buildConversationThread(
        tweet: Tweet,
        maxReplies: number = 10
    ): Promise<Tweet[]> {
        const thread: Tweet[] = [];
        const visited: Set<string> = new Set();

        // Use a bound inner function so that 'this' refers to the TwitterInteractionClient
        const processThread = async (
            currentTweet: Tweet,
            depth: number = 0
        ) => {
            elizaLogger.log("Processing tweet:", {
                id: currentTweet.id,
                inReplyToStatusId: currentTweet.inReplyToStatusId,
                depth: depth,
            });
            if (!currentTweet) {
                elizaLogger.log("No current tweet found for thread building");
                return;
            }
            if (depth >= maxReplies) {
                elizaLogger.log("Reached maximum reply depth", depth);
                return;
            }
            // Save the tweet to memory if not already saved
            const memory = await this.runtime.messageManager.getMemoryById(
                stringToUuid(currentTweet.id + "-" + this.runtime.agentId)
            );
            if (!memory) {
                const roomId = stringToUuid(
                    currentTweet.conversationId + "-" + this.runtime.agentId
                );
                const userId = stringToUuid(currentTweet.userId);
                await this.runtime.ensureConnection(
                    userId,
                    roomId,
                    currentTweet.username,
                    currentTweet.name,
                    "twitter"
                );
                this.runtime.messageManager.createMemory({
                    id: stringToUuid(
                        currentTweet.id + "-" + this.runtime.agentId
                    ),
                    agentId: this.runtime.agentId,
                    content: {
                        text: currentTweet.text,
                        source: "twitter",
                        url: currentTweet.permanentUrl,
                        inReplyTo: currentTweet.inReplyToStatusId
                            ? stringToUuid(
                                  currentTweet.inReplyToStatusId +
                                      "-" +
                                      this.runtime.agentId
                              )
                            : undefined,
                    },
                    createdAt: currentTweet.timestamp * 1000,
                    roomId,
                    userId:
                        currentTweet.userId === this.client.profile.id
                            ? this.runtime.agentId
                            : stringToUuid(currentTweet.userId),
                    embedding: getEmbeddingZeroVector(),
                });
            }
            if (visited.has(currentTweet.id)) {
                elizaLogger.log("Already visited tweet:", currentTweet.id);
                return;
            }
            visited.add(currentTweet.id);
            thread.unshift(currentTweet);
            elizaLogger.debug("Current thread state:", {
                length: thread.length,
                currentDepth: depth,
                tweetId: currentTweet.id,
            });
            if (currentTweet.inReplyToStatusId) {
                elizaLogger.log(
                    "Fetching parent tweet:",
                    currentTweet.inReplyToStatusId
                );
                try {
                    // Use the twitter client from our client property
                    const parentTweet =
                        await this.client.twitterClient.getTweet(
                            currentTweet.inReplyToStatusId
                        );
                    if (parentTweet) {
                        elizaLogger.log("Found parent tweet:", {
                            id: parentTweet.id,
                            text: parentTweet.text?.slice(0, 50),
                        });
                        await processThread(parentTweet, depth + 1);
                    } else {
                        elizaLogger.log(
                            "No parent tweet found for:",
                            currentTweet.inReplyToStatusId
                        );
                    }
                } catch (error) {
                    elizaLogger.log("Error fetching parent tweet:", {
                        tweetId: currentTweet.inReplyToStatusId,
                        error,
                    });
                }
            } else {
                elizaLogger.log(
                    "Reached end of reply chain at:",
                    currentTweet.id
                );
            }
        };

        await processThread.bind(this)(tweet, 0);
        elizaLogger.debug("Final thread built:", {
            totalTweets: thread.length,
            tweetIds: thread.map((t) => ({
                id: t.id,
                text: t.text?.slice(0, 50),
            })),
        });
        return thread;
    }
}
