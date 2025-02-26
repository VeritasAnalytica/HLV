import { SearchMode } from "agent-twitter-client";
import {
    composeContext,
    elizaLogger,
    generateMessageResponse,
    generateText,
    messageCompletionFooter,
    Content,
    HandlerCallback,
    IAgentRuntime,
    IImageDescriptionService,
    ModelClass,
    ServiceType,
    State,
    stringToUuid,
} from "@elizaos/core";
import { ClientBase } from "./base";
import { buildConversationThread, sendTweet, wait } from "./utils";

interface NewsItem {
    title: string;
    url: string;
    image: string;
    description: string;
    source: string;
}

// Template for generating Twitter responses
const TWITTER_SEARCH_TEMPLATE =
    `
{{timeline}}

{{providers}}

Recent interactions between {{agentName}} and other users:
{{recentPostInteractions}}

About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

Recent Lottery News:
{{lotteryNews}}

{{postDirections}}

{{recentPosts}}

# Task: Respond to the following post in the style and perspective of {{agentName}}
(aka @{{twitterUserName}}). Write a {{adjective}} response for {{agentName}} to say
directly in response to the post. Include a relevant lottery news insight if appropriate.
{{currentPost}}

IMPORTANT: Your response must be 20 words or fewer, leaving room for a trailing "Learn more: https://boostlottery.io/".
. and don't return anything expect the tweet content
Aim for 1-2 short sentences maximum. Be concise and direct.

Your response should not contain any questions. Brief, concise statements only.
No emojis. Use \\n\\n (double spaces) between statements.
` + messageCompletionFooter;

export class TwitterSearchClient {
    private readonly respondedTweets: Set<string> = new Set();
    private readonly LUNAR_CRUSH_API_KEY =
        "fe86qpt128h60sv2g8jysc6qffm6eckvitbd8f0q";
    private readonly SEARCH_INTERVAL_MIN = 60;
    private readonly SEARCH_INTERVAL_MAX = 120;

    constructor(
        private readonly client: ClientBase,
        private readonly runtime: IAgentRuntime,
        private readonly twitterUsername: string = client.twitterConfig
            .TWITTER_USERNAME
    ) {}

    async start(): Promise<void> {
        this.engageWithSearchTermsLoop();
    }

    private async fetchNewsFromLunarCrush(): Promise<NewsItem[]> {
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
            if (!newsData?.data?.length) {
                throw new Error("No news data returned from LunarCrush");
            }

            return newsData.data.slice(0, 5).map((news: any) => ({
                title: news.post_title,
                url: news.post_link,
                image: news.post_image,
                description: news.post_title,
                source: news.creator_display_name,
            }));
        } catch (error) {
            elizaLogger.error("Error fetching news:", error);
            return [];
        }
    }

    private async generateImageDescriptions(
        photos: Array<{ url: string }>
    ): Promise<string[]> {
        const imageDescriptionService =
            this.runtime.getService<IImageDescriptionService>(
                ServiceType.IMAGE_DESCRIPTION
            );

        const descriptions = [];
        for (const photo of photos) {
            const description = await imageDescriptionService.describeImage(
                photo.url
            );
            descriptions.push(description);
        }
        return descriptions;
    }

    private async handleTweetResponse(
        selectedTweet: any,
        message: any,
        state: State,
        responseContent: Content
    ): Promise<void> {
        try {
            const callback: HandlerCallback = async (response: Content) => {
                elizaLogger.log("Posting response tweet:", response.text); // Log the final response being posted

                console.log("Posting response tweet:", response.text)
                return sendTweet(
                    this.client,
                    response,
                    message.roomId,
                    this.twitterUsername,
                    selectedTweet.id
                );
            };

            const responseMessages = await callback(responseContent);

            let updatedState =
                await this.runtime.updateRecentMessageState(state);

            for (const responseMessage of responseMessages) {
                await this.runtime.messageManager.createMemory(
                    responseMessage,
                    false
                );
            }

            updatedState =
                await this.runtime.updateRecentMessageState(updatedState);
            await this.runtime.evaluate(message, updatedState);
            await this.runtime.processActions(
                message,
                responseMessages,
                updatedState,
                callback
            );

            this.respondedTweets.add(selectedTweet.id);

            const responseInfo = `
        Context:\n\n${state.context}\n\n
        Selected Post: ${selectedTweet.id} - ${selectedTweet.username}: ${selectedTweet.text}\n
        Agent's Output:\n${responseContent.text}
      `;

            await this.runtime.cacheManager.set(
                `twitter/tweet_generation_${selectedTweet.id}.txt`,
                responseInfo
            );

            await wait();
        } catch (error) {
            elizaLogger.error("Error handling tweet response:", error);
        }
    }

    private engageWithSearchTermsLoop(): void {
        this.engageWithSearchTerms().catch((error) =>
            elizaLogger.error("Error in search terms loop:", error)
        );

        const randomMinutes =
            Math.floor(
                Math.random() *
                    (this.SEARCH_INTERVAL_MAX - this.SEARCH_INTERVAL_MIN + 1)
            ) + this.SEARCH_INTERVAL_MIN;

        elizaLogger.log(
            `Next twitter search scheduled in ${randomMinutes} minutes`
        );

        setTimeout(
            () => this.engageWithSearchTermsLoop(),
            randomMinutes * 60 * 1000
        );
    }

    // import { wait } from "./utilities"; // Example path for the wait function

    private async engageWithSearchTerms(retries: number = 3): Promise<void> {
        elizaLogger.log("Engaging with search terms");

        try {
            const searchTerm = this.getRandomSearchTerm();
            elizaLogger.log("Using search term:", searchTerm); // Log the search term

            const [recentTweets, homeTimeline] = await Promise.all([
                this.fetchRecentTweets(searchTerm),
                this.client.fetchHomeTimeline(50),
            ]);
            await this.client.cacheTimeline(homeTimeline);

            const formattedTimeline = this.formatHomeTimeline(homeTimeline);
            const validTweets = this.filterAndRandomizeTweets(
                recentTweets,
                homeTimeline
            );

            if (!validTweets.length) {
                elizaLogger.log(
                    `No valid tweets found for the search term: ${searchTerm}`
                );

                if (retries > 0) {
                    elizaLogger.log(`Retrying... (${retries} retries left)`);
                    await wait(5000); // Adjust delay time as needed
                    return this.engageWithSearchTerms(retries - 1);
                } else {
                    elizaLogger.log("No valid tweets found after retries");
                    return;
                }
            }

            // Proceed with existing processing steps when validTweets is found
            const selectedTweet =
                await this.selectMostInterestingTweet(validTweets);
            if (
                !selectedTweet ||
                selectedTweet.username === this.twitterUsername
            ) {
                elizaLogger.log(
                    "No suitable tweet selected or tweet is from bot itself"
                );
                return;
            }




            console.log("selectedTweetttttttttttttt issssssss", selectedTweet)
            const message = await this.prepareMessage(selectedTweet);
            const state = await this.prepareState(
                selectedTweet,
                message,
                formattedTimeline
            );

            const responseContent = await this.generateResponse(message, state);
            if (!responseContent.text?.trim()) {
                elizaLogger.warn("No response text generated");
                return;
            }

            console.log("responseContentttttttttttttt issssssss", responseContent)
            // console.log("messageeeeeeeee issssssss", message)
            // console.log("stateeeeeeeee issssssss", state)
            await this.handleTweetResponse(
                selectedTweet,
                message,
                state,
                responseContent
            );
        } catch (error) {
            elizaLogger.error("Error in engageWithSearchTerms:", error);
        }
    }

    private getRandomSearchTerm(): string {
        const topics = [...this.runtime.character.topics];
        return topics[Math.floor(Math.random() * topics.length)];
    }

    private async fetchRecentTweets(searchTerm: string) {
        await wait(5000); // Rate limit protection
        const tweets = await this.client.fetchSearchTweets(
            searchTerm,
            20,
            SearchMode.Latest
        );

        console.log(tweets)
        elizaLogger.log(
            "Fetched recent tweets:",
            JSON.stringify(tweets, null, 2)
        ); // Log the fetched tweets
        return tweets;
    }

    private formatHomeTimeline(timeline: any[]): string {
        return (
            `# ${this.runtime.character.name}'s Home Timeline\n\n` +
            timeline
                .map(
                    (tweet) =>
                        `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})${
                            tweet.inReplyToStatusId
                                ? ` In reply to: ${tweet.inReplyToStatusId}`
                                : ""
                        }\nText: ${tweet.text}\n---\n`
                )
                .join("\n")
        );
    }

    private formatNewsItems(newsItems: NewsItem[]): string {
        return newsItems
            .map(
                (news, index) =>
                    `${index + 1}. **${news.title}**\nSource: ${news.source}\n[Read more](${news.url})\n`
            )
            .join("\n");
    }

    private filterAndRandomizeTweets(
        recentTweets: any,
        homeTimeline: any[]
    ): any[] {
        const filteredTweets = [...recentTweets.tweets, ...homeTimeline]
            .filter((tweet) => {
                const thread = tweet.thread;
                return (
                    !thread.find(
                        (t: any) => t.username === this.twitterUsername
                    ) && tweet.text.includes("lottery") // Add lottery check
                );
            })
            .sort(() => Math.random() - 0.5)
            .slice(0, 20);

        elizaLogger.log(
            "Filtered and randomized tweets:",
            JSON.stringify(filteredTweets, null, 2)
        ); // Log the filtered tweets
        return filteredTweets;
    }

    private async selectMostInterestingTweet(tweets: any[]): Promise<any> {
        const prompt = this.buildTweetSelectionPrompt(tweets);
        const response = await generateText({
            runtime: this.runtime,
            context: prompt,
            modelClass: ModelClass.SMALL,
        });

        const tweetId = response.trim();
        const selectedTweet = tweets.find(
            (tweet) =>
                tweet.id.toString().includes(tweetId) ||
                tweetId.includes(tweet.id.toString())
        );

        console.log(selectedTweet)
        elizaLogger.log(
            "Selected tweet:",
            JSON.stringify(selectedTweet, null, 2)
        ); // Log the selected tweet
        return selectedTweet;
    }

    private buildTweetSelectionPrompt(tweets: any[]): string {
        return `
      Here are some tweets to consider:

      ${tweets
          .map(
              (tweet) => `
        ID: ${tweet.id}${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}
        From: ${tweet.name} (@${tweet.username})
        Text: ${tweet.text}
      `
          )
          .join("\n")}

      Which tweet is the most interesting and relevant for Ruby to reply to?
      Please provide only the ID of the tweet in your response.
      Notes:
        - Respond to English tweets only
        - Respond to tweets that don't have a lot of hashtags, links, URLs or images
        - Respond to tweets that are not retweets
        - Respond to tweets where there is an easy exchange of ideas to have with the user
        - ONLY respond with the ID of the tweet
    `;
    }

    private async prepareMessage(selectedTweet: any) {
        const conversationId = selectedTweet.conversationId;
        const roomId = stringToUuid(
            conversationId + "-" + this.runtime.agentId
        );
        const userIdUUID = stringToUuid(selectedTweet.userId as string);

        await this.runtime.ensureConnection(
            userIdUUID,
            roomId,
            selectedTweet.username,
            selectedTweet.name,
            "twitter"
        );

        await buildConversationThread(selectedTweet, this.client);

        return {
            id: stringToUuid(selectedTweet.id + "-" + this.runtime.agentId),
            agentId: this.runtime.agentId,
            content: {
                text: selectedTweet.text,
                url: selectedTweet.permanentUrl,
                inReplyTo: selectedTweet.inReplyToStatusId
                    ? stringToUuid(
                          selectedTweet.inReplyToStatusId +
                              "-" +
                              this.runtime.agentId
                      )
                    : undefined,
            },
            userId: userIdUUID,
            roomId,
            createdAt: selectedTweet.timestamp * 1000,
        };
    }

    private async prepareState(
        selectedTweet: any,
        message: any,
        formattedTimeline: string
    ) {
        const replyContext = selectedTweet.thread
            .filter((reply) => reply.username !== this.twitterUsername)
            .map((reply) => `@${reply.username}: ${reply.text}`)
            .join("\n");

        let tweetBackground = "";
        if (selectedTweet.isRetweet) {
            const originalTweet = await this.client.requestQueue.add(() =>
                this.client.twitterClient.getTweet(selectedTweet.id)
            );
            tweetBackground = `Retweeting @${originalTweet.username}: ${originalTweet.text}`;
        }

        const imageDescriptions = await this.generateImageDescriptions(
            selectedTweet.photos
        );

        // Fetch lottery news
        const lotteryNews = await this.fetchNewsFromLunarCrush();
        console.log("lottery news", lotteryNews);
        const formattedLotteryNews = this.formatNewsItems(lotteryNews);

        return this.runtime.composeState(message, {
            twitterClient: this.client.twitterClient,
            twitterUserName: this.twitterUsername,
            timeline: formattedTimeline,
            lotteryNews: formattedLotteryNews,
            tweetContext: this.buildTweetContext(
                selectedTweet,
                tweetBackground,
                replyContext,
                imageDescriptions
            ),
        });
    }

    private buildTweetContext(
        tweet: any,
        background: string,
        replyContext: string,
        imageDescriptions: string[]
    ): string {
        return `
      ${background}

      Original Post:
      By @${tweet.username}
      ${tweet.text}
      ${replyContext.length > 0 ? `\nReplies to original post:\n${replyContext}` : ""}
      Original post text: ${tweet.text}
      ${tweet.urls.length > 0 ? `URLs: ${tweet.urls.join(", ")}\n` : ""}
      ${imageDescriptions.length > 0 ? `\nImages in Post (Described): ${imageDescriptions.join(", ")}\n` : ""}
    `;
    }

    private async generateResponse(
        message: any,
        state: State
    ): Promise<Content> {
        const context = composeContext({
            state,
            template:
                this.runtime.character.templates?.twitterSearchTemplate ||
                TWITTER_SEARCH_TEMPLATE,
        });

        const responseContent = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        // Manually append the LinkedIn URL regardless of the generated text
        const linkedInUrl = "boostlottery.io";
        responseContent.text = `${responseContent.text.trim()} Learn more: ${linkedInUrl}`;

        elizaLogger.log("Generated response:", responseContent.text); // Log the generated response
        responseContent.inReplyTo = message.id;
        return responseContent;
    }
}
