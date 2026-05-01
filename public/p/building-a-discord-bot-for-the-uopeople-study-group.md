Okay so this is the second post in what I'm starting to consider my "built while waiting for Valorant to find me a match" series. The first one was MyDE. This one is a Discord bot that is, as of right now, actively running and being used by hundreds of people in the UoPeople Study Group Discord server. That feels worth writing about.

For context on the backstory: I'm a student at the University of the People. There's no official UoPeople Discord server run by the university, but there are several unofficial student-run study group servers. The one I participate the most in is the the UoPeople Study Group server, the biggest one. It's got something like 600 members, students from all over the world, and it's been running for years as a completely volunteer effort. I've been a member for a while, and at some point I started paying attention to the kinds of problems the admins were dealing with.

The two big ones that kept coming up were raids and scam posts. Discord raids are when someone joins a server specifically to cause chaos — posting spam, pinging everyone with `@everyone` or `@here`, generally making life miserable for the people trying to study. The fact that new members could join and immediately ping the entire server was an obvious hole. The scam post problem was a different flavor of the same thing: someone joins, posts a Discord invite link or a phishing URL, and before any human moderator can react, fifty people have already seen it.

There's another, the second largest, UoPeople Discord server called UoPeople DSG, and they have their own in-house bot that handles a lot of this. It does verification, moderation, the works. A few people asked if they could use it or get access to the code. The answer was no — it's their bot, their code, totally their right. But it did leave the UoPeopleSG server in the position of needing something similar with no path to just borrowing one. So I volunteered to build it. The head admin said go ahead because what choice did he have.

The plan was a verification system that gates new members behind a button click before they can see any channels (which kills raids almost entirely), automated moderation that watches for scam links and invite links and acts on them faster than any human can. There was also going to be a honeypot channel that instabans users that post in it, since scam raids have a pattern of posting in every channel they can access. A few legit members posted here despite warnings and will be missed. In addition, since we're going to have a bot anyway, we can have welcome messages for new members, a scheduled task that scrapes UoPeople's press release page and posts new articles to a dedicated channel, and a channel that auto-purges its contents twice a day (this was previously done manually).

And I wanted to host it for as close to zero dollars as possible, because I'm a student at a low-tuition university and spending money on hobby projects feels philosophically inconsistent.

Here's how I built it.

---

## Step 1: The Architecture Decision That Saved Me Money

The first and most important decision was figuring out what actually needs to be always-on versus what can be serverless. This is the decision that let me host the whole thing for free.

A Discord bot has two fundamentally different modes of communication with Discord. The first is the **Interactions API** — when a user types a slash command or clicks a button, Discord sends an HTTP POST request to a URL you've registered. This is purely request/response: Discord hits your endpoint, you reply within 3 seconds, done. This is completely stateless and perfectly suited for serverless hosting. The second is the **Gateway** — a persistent WebSocket connection that lets your bot receive real-time events like messages being posted, members joining, reactions being added. This requires a process that's always running with an open connection. You can't run it on a serverless function.

So the architecture splits naturally along that line. The interactions endpoint and all the scheduled task endpoints live in a **Next.js app deployed on Vercel** — completely serverless, completely free on Vercel's hobby tier, spins up on demand when a request comes in. The gateway listener that watches for new members and message events is a separate **Node.js process** running `discord.js`, which I host on a small persistent process host. The two pieces never talk to each other directly; they both talk to Discord independently.

```
Discord ──── HTTP POST ────▶ Vercel (Next.js)
         ◀── HTTP Response ─── /v1/interactions   (slash commands, buttons)
                                /v1/tasks/...       (scheduled endpoints)

Discord ◀──── WebSocket ────▶ Persistent Node.js process
                                listener/index.ts   (welcome, moderation)

GitHub Actions ──── cron ──▶ Vercel task endpoints (every 6h, twice daily)
```

The GitHub Actions piece is the second cost-saving trick. For the scheduled tasks — checking for new press releases, purging a channel — I don't need a paid scheduler service. GitHub Actions has free cron jobs that just `curl` my Vercel endpoints on a schedule. GitHub does the scheduling, Vercel runs the logic, and the whole thing costs me nothing.

The project structure reflects this split:

```
app/
  v1/interactions/route.ts              # Handles Discord slash commands and buttons
  v1/tasks/get-press-releases/route.ts  # Scrapes UoPeople press page
  v1/tasks/purge-sensitive-channel/route.ts  # Bulk-deletes channel messages
lib/
  discord/commands.ts                   # Slash command and button logic
listener/
  index.ts                              # Gateway listener (welcome, moderation)
  package.json                          # Separate deps for the listener
scripts/
  register.ts                           # Registers slash commands with Discord
.github/workflows/
  get-press-releases.yml                # Cron: every 6 hours
  purge-sensitive-channel.yml           # Cron: twice daily
data/
  last-press.json                       # Persisted state for press release tracking
```

---

## Step 2: Scaffolding the Next.js App

The Next.js app is the serverless core. I bootstrapped it with `create-next-app`:

```bash
npx create-next-app@latest uopsg-bot --typescript --tailwind --app
```

I'm using the App Router because that's the current default and the route handlers it provides are exactly what I need — each `route.ts` file in the `app/` directory becomes an HTTP endpoint, and I can run them on Vercel's edge runtime or Node runtime depending on what they need. The interactions endpoint runs on the edge runtime (faster cold starts, globally distributed) and the task endpoints run on the default Node runtime since they need heavier libraries like Cheerio.

The dependencies are minimal but specific:

```json
{
  "dependencies": {
    "@discordjs/rest": "^2.6.1",
    "cheerio": "^1.2.0",
    "discord-interactions": "^4.4.0",
    "next": "16.2.4",
    "node-fetch": "^3.3.2",
    "react": "19.2.4",
    "react-dom": "19.2.4"
  }
}
```

`discord-interactions` is Discord's official library for verifying interaction signatures and working with the Interactions API — it's much lighter than `discord.js` and doesn't carry any WebSocket or Gateway code. `@discordjs/rest` is Discord.js's REST client, which I use in the slash command registration script. `cheerio` is jQuery-style HTML parsing for the server side, used in the press release scraper. The listener has its own `package.json` in `listener/` with `discord.js` listed there separately, keeping the two dependency trees clean.

---

## Step 3: Verifying Discord's Signature

Before the interactions endpoint does anything, it has to verify that the incoming request actually came from Discord and not from someone trying to spoof it. Discord signs every interaction request with an Ed25519 signature using your app's public key. If the signature doesn't check out, you reject the request with a 401 and move on. Skipping this verification is a critical security mistake — without it, anyone who knows your endpoint URL can send fake interactions.

The `app/v1/interactions/route.ts` file handles this:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { verifyKey } from 'discord-interactions'
import { handleInteraction } from '@/lib/discord/commands'

export const runtime = 'edge'

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY ?? process.env.NEXT_PUBLIC_DISCORD_PUBLIC_KEY

export async function POST(req: NextRequest) {
  try {
    if (!PUBLIC_KEY) {
      return new NextResponse('Missing Discord public key', { status: 500 })
    }

    const signature = req.headers.get('x-signature-ed25519')!
    const timestamp = req.headers.get('x-signature-timestamp')!
    const rawBody = await req.text()

    const isValid = await verifyKey(rawBody, signature, timestamp, PUBLIC_KEY)

    if (!isValid) {
      return new NextResponse('Invalid signature', { status: 401 })
    }

    const interaction = JSON.parse(rawBody)

    if (interaction.type === 1) {
      return NextResponse.json({ type: 1 })
    }

    return await handleInteraction(interaction)

  } catch (err) {
    console.error("Discord interaction error:", err)
    return new NextResponse(
      JSON.stringify({ error: 'Internal Server Error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
```

Three things worth noting here. First, `export const runtime = 'edge'` puts this endpoint on Vercel's edge network, meaning it runs geographically close to wherever Discord's infrastructure is making the request from — this matters because Discord requires a response within 3 seconds or it considers the interaction failed. Second, `await req.text()` reads the raw body as a string before parsing it. The signature verification needs the raw bytes, not a parsed JSON object — if you call `req.json()` first and then try to re-serialize it, the byte-level representation might differ and the signature check will fail. This is a subtle but very real gotcha. Third, `interaction.type === 1` is Discord's PING — when you first register your interactions endpoint in the developer portal, Discord sends a ping to verify the endpoint is working. You have to respond with `{ type: 1 }` or Discord won't save your URL.

The `PUBLIC_KEY` variable falls back between two env var names because I was being pragmatic during development — `NEXT_PUBLIC_` variables are accessible in client-side code, which is a security antipattern for production but convenient during local dev with ngrok.

---

## Step 4: Slash Commands and the Verification System

All the command logic lives in `lib/discord/commands.ts`. The two commands the bot has are `/ping` (a health check, every bot needs one) and `/init-verification`, which is the admin command that actually sets up the raid defense.

The `handleInteraction` function routes based on interaction type and command name:

```typescript
export async function handleInteraction(interaction: DiscordInteraction) {
  if (interaction.type === 2) {  // APPLICATION_COMMAND
    const { name } = interaction.data

    if (name === 'ping') {
      return jsonResponse({ type: 4, data: { content: '🏓 Pong!' } })
    }

    if (name === 'init-verification') {
      // ... handles verification panel setup
    }
  }

  if (interaction.type === 3) {  // MESSAGE_COMPONENT (button click)
    // ... handles verify button click
  }
}
```

The `init-verification` command is admin-only. Rather than relying on Discord's built-in permission system (which can be overridden by server admins), I check the permissions manually in code:

```typescript
function isAdmin(interaction: APIChatInputApplicationCommandInteraction) {
  const permissions = interaction.member?.permissions
  if (!permissions) return false
  const adminPermission = BigInt(8)
  const memberPermissions = BigInt(permissions)
  return (memberPermissions & adminPermission) === adminPermission
}
```

Discord sends permissions as a string representation of a permission bitfield — the number `8` is the Administrator flag. We convert both to `BigInt` because JavaScript's regular `number` type only has 53 bits of precision and Discord's permission values can exceed that. If you do this check with regular numbers, you'll get silent precision loss and potentially wrong results.

When an admin runs `/init-verification channel_id:<some-channel>`, the bot posts a verification panel in that channel:

```typescript
async function sendVerificationPanel(channelId: string, roleId: string) {
  await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content:
        "## We're excited to have you here! \nPlease click the button below to get verified and access the rest of the channels. This helps us defend against raids and ensures a better experience for everyone. \n <:BLANK_ICON:1497426116070211614>",
      components: [
        {
          type: 1,  // ACTION_ROW
          components: [
            {
              type: 2,  // BUTTON
              style: 3, // SUCCESS (green)
              label: '✔ Click to Verify',
              custom_id: `verify:${roleId}`,
            },
          ],
        },
      ],
    }),
  })
}
```

The button's `custom_id` encodes the role ID directly: `verify:864028935619608587`. When someone clicks the button, Discord fires a type 3 interaction (MESSAGE_COMPONENT) back to our endpoint with that `custom_id`, and we extract the role ID from it:

```typescript
if (interaction.type === 3) {
  const customId = (interaction.data as { custom_id?: string }).custom_id ?? ''

  if (!customId.startsWith('verify:')) {
    return jsonResponse({ type: 4, data: { content: 'Unknown button action.', flags: 64 } })
  }

  const roleId = customId.slice('verify:'.length)
  const guildId = interaction.guild_id
  const userId = interaction.member?.user?.id ?? interaction.user?.id

  await addVerificationRole(guildId, userId, roleId)

  return jsonResponse({
    type: 4,
    data: { content: 'You are now verified.', flags: 64 }
  })
}
```

The `flags: 64` on all the response messages marks them as ephemeral — only the user who triggered the interaction sees them. This keeps the verification channel clean. The role assignment itself is a `PUT` to Discord's members/roles API endpoint, which idempotently adds a role to a user regardless of whether they already have it.

The `BLANK_ICON` custom emoji in the panel message is a 1x1 transparent pixel uploaded as a custom emoji — a common Discord trick for adding spacing or visual padding in messages where you can't use regular whitespace freely.

---

## Step 5: Registering the Slash Commands

Discord doesn't automatically know your slash commands exist. You have to explicitly register them via the API before they appear in the client. I built a small interactive script for this:

```typescript
// scripts/register.ts
import { REST } from '@discordjs/rest'
import { Routes } from 'discord-api-types/v10'
import readline from 'readline'

const commands = [
  {
    name: 'ping',
    description: 'Replies with Pong!',
  },
  {
    name: 'init-verification',
    description: 'Posts a verification panel in a channel.',
    default_member_permissions: '8',  // Admin only
    dm_permission: false,
    options: [
      {
        name: 'channel_id',
        description: 'The channel id to post the verification panel in.',
        type: 3,  // STRING
        required: true,
      },
    ],
  },
]

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN)
await rest.put(Routes.applicationCommands(DISCORD_APPLICATION_ID), { body: commands })
```

Running `npx tsx scripts/register.ts` prompts for a bot token and application ID, then registers all commands globally. `default_member_permissions: '8'` tells Discord to only show the command to users with the Administrator permission — this is a UI hint that prevents the command from appearing in the menu for regular users, on top of the server-side check in the command handler. `dm_permission: false` prevents the command from being used in DMs.

Global command registration can take up to an hour to propagate across Discord's infrastructure. During development, you'd register commands to a specific guild ID instead (instant propagation), and then switch to global registration before going to production.

---

## Step 6: The Gateway Listener

The listener is the other half of the bot and it's where the real-time moderation happens. It lives in `listener/` as its own mini Node.js project with its own `package.json`, completely separate from the Next.js app. It uses `discord.js` v14, which is the full-featured library with WebSocket support.

```typescript
// listener/index.ts
import "dotenv/config";
import { Client, GatewayIntentBits, ActivityType, PermissionFlagsBits } from "discord.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})
```

The `intents` array tells Discord which events you want to receive over the Gateway. This is important for two reasons: one, Discord won't send you events you haven't requested, and two, some intents (`GuildMembers` and `MessageContent`) are "privileged" and have to be manually enabled in the Discord developer portal for your application before your bot can request them. If you declare them in code but haven't enabled them in the portal, your bot will fail to start.

`MessageContent` specifically is required to read the text content of messages — Discord added this as a privileged intent in 2022 as a privacy measure. Without it, `message.content` is always an empty string, which would make the scam detection completely useless.

The bot's status is set on startup:

```typescript
client.once("clientReady", () => {
  client.user?.setPresence({
    status: 'idle',
    activities: [
      {
        name: 'the UoPeople Study Group Discord Server',
        type: ActivityType.Watching,
      },
    ],
  })
})
```

`ActivityType.Watching` gives the bot "Watching the UoPeople Study Group Discord Server" as its status, which is a small touch but makes it look more intentional than the default "Playing a game."

---

## Step 7: The Scam Detection and Moderation Logic

This is the part that actually matters for keeping the server safe. The `messageCreate` event fires for every message in every channel the bot has access to, so the detection logic needs to be fast and accurate — false positives mean muting innocent students, which is bad. ig.

The detection runs through four checks in order:

```typescript
const INVITE_LINK_REGEX = /https?:\/\/(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[A-Za-z0-9-]+/i

const SHORTENED_URL_REGEX = /https?:\/\/(bit\.ly|tinyurl\.com|short\.link|goo\.gl|ow\.ly|rebrand\.ly|t\.co|buff\.ly|adf\.ly|is\.gd|tni\.li|bitly\.com|shorturl\.at|cutt\.us)\//i

const SCAM_KEYWORDS = [
  "verify your account", "claim your reward", "limited time offer",
  "confirm identity", "urgent action required", "verify now",
  "confirm now", "update payment", "suspended account", "verify email",
]

const SUSPICIOUS_DOMAINS = [
  "steam-community.com", "steamcommunity-verification.com", "nitro-gift.com",
  "discord-nitro.me", "steam-gifts.com", "discord-verification.com", "nitro-codes.com",
]

function isViolatingMessage(content: string): boolean {
  if (INVITE_LINK_REGEX.test(content)) return true
  if (SHORTENED_URL_REGEX.test(content)) return true
  if (SUSPICIOUS_DOMAINS.some(domain => content.toLowerCase().includes(domain))) return true
  const lowerContent = content.toLowerCase()
  if (SCAM_KEYWORDS.some(keyword => lowerContent.includes(keyword))) return true
  return false
}
```

The invite link regex catches both `discord.gg/xyz` and `discord.com/invite/xyz` formats. The shortened URL regex is important because scammers routinely hide malicious links behind URL shorteners to get past naive domain-based filters — bit.ly, tinyurl, and the like are all in the list. The scam keyword list is focused on the social engineering language that's almost universal in phishing attempts ("verify your account", "claim your reward"), and the suspicious domains list catches the most common fake Steam and Discord Nitro phishing sites.

When a violation is detected, the action is a **24-hour timeout** (mute), not a ban:

```typescript
if (isViolatingMessage(message.content) && message.guild) {
  try {
    const member = await message.guild.members.fetch(message.author.id)

    // Mute for 24 hours (86400000 ms)
    await member.timeout(86400000, "Posted prohibited content")

    // Delete the message
    await message.delete()

    await message.channel.send(
      `Hi, <@${message.author.id}> - Your message was deleted and you're currently on mute because your message appeared to violate our rules. If you think this is a mistake, please dm <@382826892321726465> or <@248393071620177920> with your concerns.`
    )
  } catch (error) {
    // ...
  }
  return
}
```

The choice of timeout over ban is deliberate. The keyword list is broad enough that a legitimate student could theoretically trigger it — someone discussing phishing in an academic context, for example. A 24-hour timeout gives a human admin time to review and lift it if it's a false positive; a ban is irreversible without manual intervention and feels like a worse user experience for someone who got caught by an overzealous filter.

The warning message DMs two specific moderator user IDs directly as part of the in-channel message. When someone gets timed out incorrectly, they know exactly who to contact.

There's a separate, much more aggressive rule for a specific protected channel:

```typescript
if (message.channelId !== WATCH_CHANNEL_ID || !message.guild) {
  return
}

await message.guild.members.ban(message.author.id, {
  reason: `Posted in restricted channel ${WATCH_CHANNEL_ID}`,
})
```

`WATCH_CHANNEL_ID` is a channel that should have zero legitimate messages posted in it — it exists as a honeypot. If anyone posts there, they get banned immediately, no questions asked. This is specifically the channel that raiders were exploiting for server-wide pings, so the rule is intentionally nuclear: if you're posting there, you're either a raider or you've ignored every warning in the channel, and either way the outcome is the same.

---

## Step 8: Welcome Messages

The welcome message handler is the simplest piece in the listener:

```typescript
client.on("guildMemberAdd", async (member) => {
  try {
    const channel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID)

    if (!channel || !channel.isTextBased()) {
      console.error(`Welcome channel is not available or not text-based.`)
      return
    }

    await channel.send(
      `Welcome ${member} to ${member.guild.name}! Feel free to introduce yourself in this channel. Be sure to read the rules at <#812051994901741588> and get yourself some roles at <#812097807212216361>.`
    )
  } catch (error) {
    console.error("Failed to send welcome message:", error)
  }
})
```

The `${member}` interpolation in the message content resolves to a Discord user mention (`<@userId>`), which pings the new member and draws their attention to the message. The channel references `<#channelId>` are Discord's channel mention syntax — they render as clickable links in the client, so the new member can go directly to the rules and roles channels without hunting for them.

The `member.guild.channels.fetch()` call is important rather than using a cached reference — on bot startup, the channel cache might not be fully populated yet, and a cold fetch ensures you always get the channel even if the cache is stale.

---

## Step 9: Scheduled Tasks via GitHub Actions

The press release scraper and channel purger are both HTTP endpoints in the Next.js app, and GitHub Actions is what calls them on a schedule. This pattern is genuinely underrated — GitHub Actions is free for public repositories and for private repositories up to 2,000 minutes/month, and for a job that runs `curl` once every six hours, you'll never come close to hitting that limit.

The press release workflow is the more interesting of the two. The challenge is state: how does the cron job know whether there's a new press release since the last time it ran? The answer is `data/last-press.json`, a one-line JSON file committed to the repository:

```json
{"lastUrl": "https://www.uopeople.edu/about/worldwide-recognition/press-releases/university-of-the-people-and-unhcr-partner-to-expand-refugee-access-to-education/"}
```

The GitHub Actions workflow reads this file, passes the URL to the endpoint as a query parameter, and if a new release was posted, the endpoint returns the new URL and the workflow commits the updated JSON back to the repository:

```yaml
# .github/workflows/get-press-releases.yml
name: press-releases

on:
  schedule:
    - cron: "0 */6 * * *"  # every 6 hours
  workflow_dispatch:        # can also be triggered manually

jobs:
  check-press:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      - name: Read last known press URL
        id: last
        run: |
          echo "lastUrl=$(jq -r '.lastUrl' data/last-press.json)" >> $GITHUB_OUTPUT

      - name: Call press-check endpoint
        id: check
        run: |
          response=$(curl -sS "https://uopeople-sg-bot.vercel.app/v1/tasks/get-press-releases?lastUrl=${{ steps.last.outputs.lastUrl }}")
          latestUrl=$(echo "$response" | jq -r '.latestUrl')
          posted=$(echo "$response" | jq -r '.posted')
          echo "latestUrl=$latestUrl" >> $GITHUB_OUTPUT
          echo "posted=$posted" >> $GITHUB_OUTPUT

      - name: Update last-press.json
        if: steps.check.outputs.posted == 'true'
        run: |
          echo "{\"lastUrl\": \"${{ steps.check.outputs.latestUrl }}\"}" > data/last-press.json
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/last-press.json
          git commit -m "Update last press release to ${{ steps.check.outputs.latestUrl }}"
          git push
```

The `permissions: contents: write` is required for the workflow to commit back to the repository — by default, `GITHUB_TOKEN` only has read permissions on content. The `workflow_dispatch` trigger is useful during testing and debugging; it lets you manually trigger the workflow from the GitHub Actions UI without waiting for the cron schedule.

Using the git repository itself as the state store is a little unconventional, but it has some nice properties: the state is human-readable, versioned, and auditable. If something goes wrong, you can look at the git history and see exactly when each press release was first detected. And it costs exactly nothing.

---

## Step 10: The Press Release Scraper

The actual scraping logic in `app/v1/tasks/get-press-releases/route.ts` uses Cheerio, which is essentially a server-side jQuery. UoPeople's press releases page is a standard WordPress-style grid layout, so finding the most recent post is straightforward:

```typescript
import * as cheerio from "cheerio"

async function getLatestPress() {
  const res = await fetch("https://www.uopeople.edu/about/worldwide-recognition/press-releases/")
  const html = await res.text()
  const $ = cheerio.load(html)

  const first = $(".fl-post-grid-post").first()
  const title = first.find(".fl-post-title a").text().trim()
  let url = first.find(".fl-post-title a").attr("href") || ""

  if (url && !url.startsWith("http")) {
    url = `https://www.uopeople.edu${url}`
  }

  if (!title || !url) return null

  // Fetch the article itself for og:image and full content
  let image: string | null = null
  let content: string | null = null

  try {
    const articleRes = await fetch(url)
    const articleHtml = await articleRes.text()
    const $$ = cheerio.load(articleHtml)

    image = $$("meta[property='og:image']").attr("content") ||
            $$(".fl-post-content img").first().attr("src") || null

    const contentDiv = $$(".fl-rich-text")
    if (contentDiv.length > 0) {
      const paragraphs: string[] = []
      contentDiv.find("p").each((i, el) => {
        const text = $$(el).text().trim()
        if (text) paragraphs.push(text)
      })
      content = paragraphs.join("\n\n")
    }
  } catch (e) {
    console.error("Failed to fetch article content:", e)
  }

  return { url, title, image, content }
}
```

The two-step fetch (index page, then the article page) is necessary because the article list only has titles and URLs — the full content and the `og:image` featured image are only on the article page itself. Prioritizing `meta[property='og:image']` over the first image in the content is the right call because the OG image is specifically chosen by the author to represent the article, while the first content image might be a logo or decorative element.

Because Discord messages have a 2,000 character limit, the article content gets chunked before posting:

```typescript
async function postToDiscord(press: { url: string; title: string; image: string | null; content: string | null }) {
  let headerMessage = `## New Press Release from University of the People\n`
  headerMessage += `# ${press.title}\n`
  headerMessage += `**[Read the full article here](${press.url})**\n---\n`

  await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: headerMessage })
  })

  if (press.content) {
    const CHUNK_SIZE = 1950  // 50 chars of buffer below Discord's 2000 limit
    for (let i = 0; i < press.content.length; i += CHUNK_SIZE) {
      const chunk = press.content.substring(i, i + CHUNK_SIZE)
      await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
        method: "POST",
        headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: chunk })
      })
      await new Promise(resolve => setTimeout(resolve, 100))  // rate limit spacing
    }
  }
}
```

The 100ms delay between chunk messages is a small courtesy to Discord's rate limiter. Discord's rate limits for bot messages are relatively generous, but when you're posting multiple messages in quick succession, adding a small sleep is better than hitting a 429 and having to implement retry logic.

---

## Step 11: The Channel Purger

The channel purge endpoint (`app/v1/tasks/purge-sensitive-channel/route.ts`) is called twice a day via GitHub Actions and deletes all messages in a specific channel. This channel is one where members can ask sensitive questions and expect them to disappear after some time — a privacy feature as much as a moderation one.

The trickiest part of bulk-deleting Discord messages is a constraint Discord imposes: the bulk delete endpoint only works on messages that are **less than 14 days old**. Messages older than 14 days must be deleted one at a time. So the purger has to split messages into two buckets and handle each differently:

```typescript
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000

// ... inside the loop:
for (const m of messages) {
  const ts = new Date(m.timestamp).getTime()
  if (now - ts < FOURTEEN_DAYS_MS) {
    bulkableIds.push(m.id)
  } else {
    oldMessages.push({ id: m.id })
  }
}

// Bulk delete the recent ones (up to 100 at a time, minimum 2)
if (bulkableIds.length >= 2) {
  await bulkDelete(channelId, bulkableIds)
}

// Single-delete the old ones with spacing
for (const m of oldMessages) {
  await deleteMessage(channelId, m.id)
  await sleep(300)  // ~3-4 deletions per second, safe for rate limits
}
```

The rate limit handling is wrapped in a helper that parses Discord's `retry-after` header (which returns seconds as a float) and sleeps for that duration plus a small random jitter before retrying:

```typescript
async function parseRetryAfter(res: Response) {
  const header = res.headers.get("retry-after")
  if (header) {
    const v = parseFloat(header)
    if (!Number.isNaN(v)) return v * 1000  // convert seconds to ms
  }
  try {
    const body = await res.clone().json()
    if (body?.retry_after) return body.retry_after * 1000
  } catch { /* ignore */ }
  return 1000  // default fallback
}

async function fetchWithRateLimitAware(url: string, opts: RequestInit, maxRetries = 6) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, opts)
    if (res.status !== 429) return res
    const waitMs = await parseRetryAfter(res)
    const jitter = Math.random() * 200
    await sleep(waitMs + jitter)
  }
  throw new Error("Exceeded retries due to repeated 429s")
}
```

The `res.clone()` before parsing the body is necessary because Response bodies can only be read once — if `parseRetryAfter` reads the body to extract the `retry_after` field, the caller can't read it again. Cloning creates a second Response object that can be read independently.

The purge runs in a `while(true)` loop with a safety cap of 200 iterations, fetching and deleting 100 messages per iteration. The loop exits when `fetchBatch` returns an empty array (channel is empty). The safety cap prevents infinite loops if something goes wrong and the channel never empties for some reason.

---

## Step 12: The Homepage

The app has a minimal homepage at `app/page.tsx` that serves as a status dashboard and landing page for the bot. It shows three status pills (Listener, Interactions, Tasks), links to the GitHub repository, and a dynamically generated invite URL:

```typescript
export default function Home() {
  const clientId = process.env.NEXT_PUBLIC_DISCORD_APPLICATION_ID
  const permissions = 8  // Admin
  let inviteUrl = ''
  if (clientId) {
    inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&scope=bot%20applications.commands`
  }

  return (
    <main className="w-full h-screen flex flex-col text-center items-center justify-center gap-3">
      <h1 className="text-2xl font-bold">UoPeopleSG Bot</h1>
      <p>You've landed at the home of the UoPeople Study Group Discord Bot...</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <span className="inline-flex items-center rounded-full bg-neutral-500/10 px-3 py-1 text-xs font-semibold text-emerald-700">
          <span className="mr-2 h-2 w-2 rounded-full bg-emerald-500" />
          Listener: Online
        </span>
        {/* ... */}
      </div>
    </main>
  )
}
```

The status pills are hardcoded as "Online" rather than being dynamically fetched from each service — the page itself loading is evidence that the Next.js app (Interactions + Tasks) is up, and the Listener status would require a separate health check endpoint that felt like over-engineering for now. This is intentionally pragmatic. If the listener goes down, someone will notice; I don't need a green dot to tell me.

The permissions value of `8` in the invite URL is the Administrator permission, which gives the bot everything it needs. In a production bot you'd scope this down to the minimum required permissions, but for a server-specific bot that's already been reviewed by the server admins before installation, Administrator is acceptable.

---

## Step 13: Environment Variables and the Security Antipattern I Did On Purpose

This is the part where I have to be honest about a thing. Several environment variables in this project use the `NEXT_PUBLIC_` prefix, which means they're exposed to client-side JavaScript. For a public-facing consumer app, this would be a serious security issue — anyone who visits the page can open DevTools and read any `NEXT_PUBLIC_` variable. For a Discord bot token, this would be catastrophic; someone could use your token to take over your bot.

The README explicitly calls this out:

> Do not store real bot tokens in `NEXT_PUBLIC_*` variables for production. Rotate any tokens that were ever committed or shared.

The `NEXT_PUBLIC_` fallback exists purely because of how I was developing locally — I was iterating fast and the distinction between server and client env vars wasn't worth dealing with until later. In production, every sensitive variable (`DISCORD_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`) uses the non-public name and lives in Vercel's environment variable settings, never in `.env` files committed to the repo.

The `.gitignore` includes `.env*` to make sure no local env files ever accidentally get committed:

```gitignore
.env*
```

The listener gets its token from `listener/.env`, which is also gitignored. The only state that does get committed is `data/last-press.json`, which contains nothing sensitive — just a public URL.

---

## Did It Work?

Yeah, actually. The raid problem is basically gone — new members see a verification screen and nothing else until they click the button. The scam posts get deleted and the poster gets timed out usually within a second or two of posting, which is faster than any human moderator could react. The welcome messages are working, the press releases are getting posted, and the sensitive channel is purging on schedule. Ultimately as a mod of the server I can stop reading complaints of the server security when someone comes and pings the entire server with a suspicious link

The total hosting cost is zero dollars. Vercel's hobby tier covers the Next.js app comfortably — the interactions endpoint and task endpoints are invoked maybe a few hundred times a day total, nowhere near any limits. GitHub Actions covers the cron jobs. The listener is the only thing that needs a persistent host, and the free teir of Railway handles it fine since `discord.js` is not resource-hungry when it's just listening for events.

If you want to build something similar, the repo is public on [Github](https://github.com/emjjkk/uopsg-bot). The `scripts/register.ts` flow works for any bot — point it at your token and application ID and it'll register whatever commands you define. The architecture pattern scales up easily; adding a new slash command is a few lines in `commands.ts` and a new entry in the `commands` array in `register.ts`.

Until the next time I build something to save the mental health of 600 discord users.
