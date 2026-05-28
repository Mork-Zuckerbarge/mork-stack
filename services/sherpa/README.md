

## What You Need
- A computer (Windows, Mac, or Linux)
- Internet connection

## Step 1: Get Your Keys

### Twitter Keys (for posting)
1. Go to https://developer.twitter.com/portal/dashboard
2. Sign up for a developer account
3. Create a new Project and App
4. Find "Keys and Tokens"
5. Generate and save ALL of these:
   - API Key and Secret
   - Access Token and Secret
6. In your app settings, make sure to enable "Read and Write"

### Telegram Key (for sharing tweets to Telegram)

### Reddit Keys (optional cross-post)
- Reddit app client ID + secret
- Reddit username + password (script app flow)
- Target subreddit (without `r/`)
- User agent string

### Facebook Keys (optional cross-post)
- Facebook Page ID
- Facebook Page Access Token (with page publish permissions)

### Instagram Keys (optional cross-post)
- Instagram User ID (Graph API)
- Instagram Access Token
- Public image URL (required by Instagram Graph API publishing flow)

## Step 2: Install & Run

### On Windows:
1. Double-click `build.bat` and wait
2. Double-click `run.bat`
3. That's it!

### On Mac:
1. Open Terminal in the bot's folder
2. Make the scripts executable:
   ```bash
   chmod +x build.sh run.sh
   ```
3. Run the setup:
   ```bash
   ./build.sh
   ```
   - If you get permission errors, try:
     ```bash
     sudo ./build.sh
     ```
   - First run will install Homebrew and Python if needed
   - After Homebrew installs, you may need to start a new terminal
4. Start the bot:
   ```bash
   ./run.sh
   ```

### On Linux:
1. Open Terminal in the bot's folder
2. Make the scripts executable:
   ```bash
   chmod +x build.sh run.sh
   ```
3. Run the setup:
   ```bash
   ./build.sh
   ```
   - If you get permission errors, try:
     ```bash
     sudo ./build.sh
     ```
   - Different distributions use different package managers:
     - Ubuntu/Debian: Uses apt-get
     - Fedora: Uses dnf
     - CentOS/RHEL: Uses yum
     - Arch: Uses pacman
4. Start the bot:
   ```bash
   ./run.sh
   ```

## Step 3: Set Up Your Bot
1. When the app opens, paste in your API keys. Save credentials.
2. Create your character. (Or do it in the python file.)
3. Click "Begin Automation" to launch autopilot.


## Agent Configuration Model (Recommended)

Sherpa is intended to be distributable: operators should be able to create their own agent personalities from the UI without forking code or creating another service. Configure behavior as layered instructions in this order:

1. **Prime Directive** — the top-level purpose and safety boundary for the agent.
2. **Behavior + Response Policy** — channel-neutral rules for truthfulness, banned phrases, formatting, and quoting.
3. **App Persona** — the default voice for the app experience. Example default: `code-first`; `never lie. if you dont know something, admit it.`
4. **Channel Personas** — per-channel tone adapters:
   - **Telegram Persona:** `briefing`; `keep it simple, short, and funny. never lie`
   - **X Persona:** `poetic`; `you know everything. be polite.`
   - **Faceboot Persona:** `meme-chaos`; `you are ecstatic about this project.`
5. **Project Knowledge Layer** — canonical project references, facts, and FAQs the agent can use when composing or replying.
6. **Banned Phrase Layer** — configurable final outbound cleanup. Defaults protect this repo's Mork personality, but distributors can replace the list in the UI or with env vars.

Recommended Behavior + Response Policy defaults for this repo:

- Do **NOT** act like the TV character from Mork & Mindy.
- Never say: `nanu nanu`, `na-nu`, `shazbot`, `gleeb`, `gleek`, `ork`.
- Do not create false information.
- If you do not know something, say so plainly.
- Max response characters example: `4500`.
- Allow URLs in replies: enabled/disabled by policy.
- Allow quoting user messages: disabled.

Distributors can override bundled defaults without editing code:

- `SHERPA_AGENT_PROJECT_NAME` — default project/agent name shown in Sherpa.
- `SHERPA_DEFAULT_PROJECT_SOURCES` — newline- or comma-separated project knowledge source URLs.
- `SHERPA_BANNED_PHRASES` — newline- or comma-separated Sherpa outbound banned phrases.
- `NEXT_PUBLIC_AGENT_BANNED_PHRASES` — newline- or comma-separated Moltbook/Faceboot adapter banned phrases for the Next.js app.

Default `$BBQ` project knowledge sources for this repo:

- Thread: https://x.com/zuckerbarge/status/1831855846747468191?s=20
- Article tweet: https://x.com/zuckerbarge/status/2058594772684562931?s=20
- Linktree: https://linktr.ee/zuckerbarge

## Important Notes
- The bot posts every 1.5 hours
- Maximum 500 tweets per month
- Optional destination toggles in Control Center let you route each post to X, Telegram, Reddit, Facebook, and Instagram (when credentials are set)
- The following files are created automatically and contain your private data - never share them:
  - encryption.key
  - encrypted_credentials.bin
  - encrypted_characters.bin

## Help! Something's Wrong!

### Windows Users:

- Make sure you're running as Administrator if installation fails

### Mac Users:
- If Homebrew installation fails, check the [official guide](https://brew.sh)
- After installing Homebrew, you may need to restart your terminal
- If Python installation fails:
  ```bash
  brew doctor
  brew update
  brew cleanup
  ```
- Common permission fixes:
  ```bash
  sudo chown -R $(whoami) $(brew --prefix)/*
  ```

### Linux Users:
- Different distributions need different commands:
  - Ubuntu/Debian: `sudo apt-get install python3.10`
  - Fedora: `sudo dnf install python3.10`
  - CentOS/RHEL: `sudo yum install python3.10`
  - Arch: `sudo pacman -Sy python`
- If Python is installed but not found, check your PATH:
  ```bash
  echo $PATH
  which python3.10
  ```
- For permission issues:
  ```bash
  sudo chown -R $USER:$USER .
  ```

### Browser Issues:
- The app should open automatically in your default browser
- If it doesn't, manually go to: http://127.0.0.1:7860
- Make sure no other app is using port 7860

Still not working? Make sure:
1. Your internet connection is working
2. You copied all the API keys correctly
3. You're running from the correct directory
4. All files were extracted from the zip
5. You have the right permissions (try with sudo/admin)
6. Python 3.10 is in your system PATH
