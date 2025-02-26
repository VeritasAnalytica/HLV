

## Table of Contents

- [Setup Instructions](#setup-instructions)
  - [Prerequisites](#prerequisites)
  - [Creating Your Discord Bot](#creating-your-discord-bot)
  - [Getting Required Values](#getting-required-values)
  - [Configuration](#configuration)
  - [Adding the Bot to Your Server](#adding-the-bot-to-your-server)
  - [Enabling Privileged Gateway Intents](#Enabling-Privileged-Gateway-Intents)
- [Training Your Character File](#training-your-character-file)
- [Project Setup Instructions](#project-setup-instructions)
  - [1. Clone the Repository](#1-clone-the-repository)
  - [2. Navigate into the Project Directory](#2-navigate-into-the-project-directory)
  - [3. Install Required Dependencies](#3-install-required-dependencies)
  - [4. Install Project Dependencies](#4-install-project-dependencies)
  - [5. Build the Project](#5-build-the-project)
  - [6. Start the Project](#6-start-the-project)
  - [7. (Optional) Run with tmux on Linux Cloud](#7-optional-run-with-tmux-on-linux-cloud)

---

## Setup Instructions

### Prerequisites

- A Discord account
- Access to the [Discord Developer Portal](https://discord.com/developers/applications)

### Creating Your Discord Bot

1. Navigate to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click on **"New Application"** and assign a name to your application.
3. In the left sidebar, click on **"Bot"**.
4. Click **"Add Bot"** to create a bot user.

### Getting Required Values

#### Bot Token (`TWITTER_APPROVAL_DISCORD_BOT_TOKEN`)

1. In the Discord Developer Portal, go to your application's **"Bot"** section.
2. Click **"Reset Token"** to generate a new token.
3. Copy the token and save it securely.
    - ⚠️ **NEVER share your bot token publicly.**
    - ⚠️ **NEVER commit your bot token to version control.**

#### Channel ID (`TWITTER_APPROVAL_DISCORD_CHANNEL_ID`)

1. Open Discord.
2. Enable Developer Mode:
    - Go to **User Settings**.
    - Navigate to **App Settings → Advanced**.
    - Turn on **Developer Mode**.
3. Right-click the channel where you want the bot to operate.
4. Click **"Copy ID"** from the context menu.

#### Check Interval (`TWITTER_APPROVAL_CHECK_INTERVAL`)

- Set this value in milliseconds.
- **Default:** `60000` (1 minute)
- Adjust based on your needs:
    - 30 seconds = `30000`
    - 2 minutes = `120000`
    - 5 minutes = `300000`

### Configuration

Paste these values in the `.env` file:

```env
TWITTER_APPROVAL_DISCORD_BOT_TOKEN=your_bot_token_here
TWITTER_APPROVAL_DISCORD_CHANNEL_ID=your_channel_id_here
TWITTER_APPROVAL_CHECK_INTERVAL=60000
OPENAI_API_KEY = your openai api key here
```

### Adding the Bot to Your Server

1. In the Discord [Developer Portal](https://discord.com/developers/applications), navigate to **"OAuth2"**.
2. Under **"Scopes"**, select `bot`.
3. Under **"Bot Permissions"**, select `administrator` (or assign the permissions that best suit your requirements).
4. Copy the generated URL.
5. Open the URL in your browser, select your server, and complete the authorization process.

---

### Enabling Privileged Gateway Intents
1. In the Discord [Developer Portal](https://discord.com/developers/applications), navigate to **"Bot"**.
2. Go to **Privileged Gateway Intents** section
3. Enable all the 3 **Privileged Gateway Intents**
4. Click on "save changes"

## Training Your Character File

If you wish to train your character file, you can leverage ChatGPT or any other large language model (LLM) to streamline the process. Simply follow these steps:

1. Locate the `lottery.character.json` file in the `characters` folder.
2. Copy its contents and paste them into ChatGPT (or another LLM interface).
3. Additionally, include any other source files (like PDFs, websites) you’d like the model to consider.
4. Ask the LLM to update your character file or provide enhancements based on the new character information.
5. Review the generated suggestions and integrate them as needed to ensure your documentation is always up-to-date.

This innovative approach encourages continuous improvement and ensures your project documentation evolves with your requirements.

---

## Project Setup Instructions

Follow the steps below to properly set up and run the project on your server.

### 1. Clone the Repository

Run the following command in your terminal to clone the project repository:

```bash
git clone https://github.com/VeritasAnalytica/HLV
```

### 2. Navigate into the Project Directory

Change into the project directory:

```bash
cd HLV
```

### 3. Install Required Dependencies

Ensure that you have the required versions of Node.js, npm, and pnpm installed. Use the versions provided below:

- **Node.js:** v22.12.0
- **npm:** 10.9.0
- **pnpm:** 9.15.2

Ensure that the versions match the required ones.

### 4. Install Project Dependencies

Once inside the project directory, install dependencies by running:

```bash
pnpm install --no-frozen-lockfile
```

### 5. Build the Project

Build the project with the following command:

```bash
pnpm build
```

### 6. Start the Project

Finally, run the project using the following command, replacing `yourCharachterName` with your desired character file name from the `characters` folder:

```bash
pnpm start --character="characters/Lottery.character.json"
```

### 7. (Optional but Recommended) Run with tmux on Linux Cloud

Since the project will be deployed on a Linux cloud environment, it is recommended to use **tmux** to ensure the bot continues running even after you disconnect from your terminal session. Follow these steps:

1. **Install tmux (if not already installed):**

   ```bash
   sudo apt-get update && sudo apt-get install tmux
   ```
   *(For other distributions, use the appropriate package manager command.)*

2. **Create a new tmux session:**

   ```bash
   tmux new -s bot_session
   ```

3. **Start your project within the tmux session:**

   ```bash
   pnpm start --character="characters/Lottery.character.json"
   ```

4. **Detach from the tmux session:**  
   Press `Ctrl+b` then `d`. This will leave your bot running in the background.

5. **Reattach to your tmux session when needed:**

   ```bash
   tmux attach -t bot_session
   ```

This strategic approach ensures your application remains highly available, providing uninterrupted service in a cloud-based environment.

---


Happy coding!
