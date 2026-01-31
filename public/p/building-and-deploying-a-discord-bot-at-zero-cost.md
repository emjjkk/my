It’s been a long time since my last blog post! Today, I want to share a recent discovery on how to build a Discord bot without maintaining a persistent connection.

Traditionally, building a Discord bot means spinning up a long-running process, connecting to Discord’s Gateway via WebSockets, and keeping that connection alive indefinitely. On paper, this sounds simple. In practice, it comes with a surprising amount of overhead, such as the need for a VPS or dedicated server. Those are rarely free, and you usually pay as long as the server is running.

If your bot only gets used a few times per hour, you’re still paying for infrastructure that’s up 100% of the time. That’s a bad cost model for hobby projects, side projects, and tools built purely for fun.

On top of that, the Discord bot ecosystem is highly saturated. Monetizing a bot on its own is difficult, and making it self-sustaining is often a steep challenge.

After doing some research on how to solve this issue I came across Discord’s newer interaction model. It makes it possible to build bots that don’t require a persistent Gateway connection at all. Instead of staying connected and listening for events, you can flip the model around and let Discord call your server only when something actually happens.

When a user runs a slash command, Discord sends an HTTPS POST request to your server. Your server verifies the request signature, processes the command, and returns a response. At that point, building a Discord bot starts to look a lot like building a regular web API.

In this post, I’m documenting how I set up a bot using this interaction-based approach.

## Technologies

For the bot backend, I used Next.js, a framework I’m very familiar with. This lets me handle Discord interaction webhooks directly through API routes using the App Router, and deploy them globally as edge functions with Vercel. That means no cold starts and no server maintenance. An added bonus is that I can build a full landing page, dashboard, registration tools, or admin panels with React in the same project. Bot, backend, and website all live in one codebase, hosted in one place, which makes everything much easier to maintain.

I also integrated Supabase. Supabase works extremely well with Next.js with minimal setup and provides a ready-made backend with a great developer experience for authentication, file storage, and a PostgreSQL database.

### Project Setup

To start, I created a directory called `NextJS-Discord-Bot`, but you can name yours whatever you like. I then created a Next.js project the same way I normally would:

```bash
npx create-next-app@latest ./
```

I set up the project with all the default options enabled: TypeScript, Tailwind CSS, ESLint, and so on.

After that, I created an `.env.local` file to store my environment variables:

```
SUPABASE_SERVICE_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY=
NEXT_PUBLIC_DISCORD_TOKEN=
DISCORD_PUBLIC_KEY=
NEXT_PUBLIC_DISCORD_APPLICATION_ID=
```

## Creating Your Discord Bot

To obtain the required Discord credentials, I created and configured a Discord application in the Discord Developer Portal. I started by going to [https://discord.com/developers/applications](https://discord.com/developers/applications) and logging in with my Discord account. Once logged in, I clicked **New Application**, gave the application a name, and created it.

This application represents the bot and is where all required credentials are managed.

For `NEXT_PUBLIC_DISCORD_APPLICATION_ID`, I navigated to the **General Information** section of the application. There, I found the **Application ID**, which I copied and pasted into my environment variables. This ID uniquely identifies the Discord application and is required for authentication and interaction setup.

To get `DISCORD_PUBLIC_KEY`, I stayed in the **General Information** section and located the **Public Key** field. This key is used to verify incoming interaction requests from Discord, ensuring that requests are genuinely coming from Discord’s servers. I copied this value and stored it in my environment variables.

For `NEXT_PUBLIC_DISCORD_TOKEN`, I went to the **Bot** section in the left sidebar. If a bot had not already been created, I clicked **Add Bot**. Once the bot was created, I found the **Bot Token** section and clicked **Reset Token** or **Copy Token** to retrieve the token.

This token is used to authenticate API requests made on behalf of the bot. Because it grants full access to the bot, it should be kept secret and never committed to source control, even if it is prefixed with `NEXT_PUBLIC` in the configuration.


## Setting Up Supabase

To set up Supabase, I started by visiting [https://supabase.com](https://supabase.com) and creating an account. After logging in, I created a new project by selecting **New Project**, choosing an organization, providing a project name, setting a database password, and selecting a region.

Once the project was created, Supabase provisioned the backend and database, which took a few moments.

After the project was ready, I opened **Project Settings** in the Supabase dashboard and navigated to the **API** section. There, I copied the **Project URL** and assigned it to `NEXT_PUBLIC_SUPABASE_URL`. This URL is used by both the frontend and backend to connect to Supabase.

In the same **API** section, I located the **anon public** key (sometimes labeled as the public anon or publishable key). I copied this value and set it as `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY`. This key is safe to use in client-side applications, with Row Level Security controlling what users are allowed to access.

Supabase also provides a service role key with elevated privileges that bypass Row Level Security. To get this, I stayed in the **API** section and copied the key labeled `service_role`, then stored it as `SUPABASE_SERVICE_KEY`.


### Supabase Client Utilities

After that, I added the Supabase utility files to the project. These can be copied directly from the Supabase dashboard.

First, I created `lib/supabase/client.ts`:

```ts
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY!,
  );
}
```

Then, I created `lib/supabase/server.ts`:

```ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Especially important if using Fluid compute: Don't put this client in a
 * global variable. Always create a new client within each function when using
 * it.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    },
  );
}
```
Next I created `lib/supabase/middleware.ts`. This is slightly different from the one you copy directly from the dashboard to avoid any rerouting confusion that I encountered while I was trying to build it for the first time

```ts
import { NextResponse, type NextRequest } from "next/server";
import { hasEnvVars } from "../utils";

export async function updateSession(request: NextRequest) {
  const supabaseResponse = NextResponse.next({
    request,
  });
  if (!hasEnvVars) {
    return supabaseResponse;
  }
  return supabaseResponse;
}
```

In addition to the browser and server Supabase clients provided by supabase, I created a separate Supabase client `lib/supabase/botClient.ts` specifically for the Discord bot. This is important.

```ts
// lib/supabase/botClient.ts
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

export const supabase = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)
```

This client exists for a different purpose than the standard Next.js browser and server clients.

The `client.ts` and `server.ts` files are designed to support user-facing authentication flows and session-based access. They rely on the public anon key and cookies to determine which user is making a request, and they respect Row Level Security (RLS) policies in the database.

That model works well for normal web app requests, but it does not fit how Discord interactions work.

When Discord sends an interaction webhook, there is no logged-in Supabase user and no browser session. The request is coming from Discord’s servers, not from an authenticated user in the app. That means there is no user context for Supabase to evaluate against RLS policies.

For bot-related operations, such as:

* Creating or updating records in response to slash commands
* Managing server-level or application-level data
* Performing background or system tasks
* Accessing tables that are not tied to a specific logged-in user

the bot needs elevated, system-level access.

That is why this client uses the Supabase service role key.

The service role key bypasses Row Level Security and allows the bot to perform privileged operations safely on the server. This makes the bot act like a trusted backend service rather than a normal end user.

Separating this into its own `botClient.ts` file also makes the security boundary explicit. It reduces the risk of accidentally using the service role key in user-facing code, and makes it clear which parts of the system are allowed to perform privileged database operations.


## Creating the Interactions Endpoint

One of the most important pieces of a bot built with Discord’s new interaction model is the **interactions endpoint**. This is the URL that Discord calls whenever a user triggers a slash command, button, or other interaction. You can think of it as the bot’s “inbox,” receiving events from Discord and responding accordingly. In my project, I implemented this endpoint as a Next.js edge function so it could run globally and with low latency.

The function has both a `GET` and a `POST` handler. The `GET` handler is simple—it just returns `"OK"`. I included it mainly as a sanity check to quickly confirm that the endpoint is live and reachable, though Discord only uses the `POST` requests for actual interactions.

The `POST` handler is where the magic happens. Discord sends all interaction events as HTTP POST requests, and each request comes with a signature to prove it really came from Discord. I use the `verifyKey` function from the [discord-interactions](https://discord.com/developers/docs/interactions/receiving-and-responding#security-and-authorization) library to check that signature using my application’s public key. If the signature is invalid, the request is rejected with a 401 response. Once a request is verified, I parse the JSON body to figure out what kind of interaction it is. For example, Discord sends a special “PING” interaction (type 1) when you first register your endpoint. Responding with `{ type: 1 }` confirms that the endpoint is valid, which is required for the bot to function properly.

All other interactions, such as slash commands or button presses, are passed to a separate handler function I created, `handleCommand(interaction)`. I'll be showing how I made this later. I seperated this out to kee things tidy. This function contains the actual logic for my bot and decides how to respond to the user.

Finally, I wrapped the entire handler in a try/catch block. If any errors occur during verification or command handling, they are logged, and the endpoint returns a 500 error response. This ensures that Discord knows something went wrong without crashing the entire function.

All this lives in `app/api/interactions`, thus I set `https://<my-domain>/api/interactions` as my interactions endpoint on my Discord Developer Portal.

```ts
import { NextRequest, NextResponse } from 'next/server'
import { verifyKey } from 'discord-interactions'
import { handleCommand } from '@/lib/discord/commands'

export const runtime = 'edge'

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY!

export async function GET() {
  return new NextResponse('OK')
}

export async function POST(req: NextRequest) {
  try {
    const signature = req.headers.get('x-signature-ed25519')!
    const timestamp = req.headers.get('x-signature-timestamp')!
    const rawBody = await req.text()

    const isValid = await verifyKey(rawBody, signature, timestamp, PUBLIC_KEY)

    if (!isValid) {
      return new NextResponse('Invalid signature', { status: 401 })
    }

    // Just in case your interaction endpoint isn't getting verified and need to do serious debugging
    
    // console.log('[Discord] Signature:', signature)
    // console.log('[Discord] Timestamp:', timestamp)
    // console.log('[Discord] Raw body:', rawBody)
    // console.log('[Discord] Public key:', PUBLIC_KEY)
    // console.log('[Discord] Valid:', isValid)

    const interaction = JSON.parse(rawBody)

    
    if (interaction.type === 1) {
      return NextResponse.json({ type: 1 })
    }
    return await handleCommand(interaction)

  } catch (err) {
    console.error('❌ Discord interaction error:', err)
    return new NextResponse(
      JSON.stringify({ error: 'Internal Server Error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
}
```
## Handling Commands

Once the interaction endpoint is set up, the next piece of the puzzle is actually responding to specific user commands. That’s where the `handleCommand` function comes in. This function takes a parsed interaction from Discord and decides how the bot should reply. I wrote this in `lib/discord/commands.ts`

```ts
import type { APIChatInputApplicationCommandInteraction } from 'discord-api-types/v10'

export async function handleCommand(interaction: APIChatInputApplicationCommandInteraction) {

  const { name } = interaction.data

  if (name === 'ping') {
    return new Response(
      JSON.stringify({
        type: 4,
        data: {
          content: '🏓 Pong!',
        },
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  }

  return new Response('Unknown command', { status: 400 })
}

```
At a high level, `handleCommand` is a simple router for slash commands. I start by extracting the command name from the interaction object. In this case, if the command is `ping`, the bot responds with a classic “Pong!” message. The response is wrapped in JSON and includes a `type` of `4`, which tells Discord to send a **channel message response** back to the user. You can find more details on response types in the [Discord Interactions documentation](https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-response-object).

If the command isn’t recognized, the function returns a 400 response with the message “Unknown command.” This is a simple way to handle errors or unimplemented commands without crashing the endpoint.

Structuring the code this way keeps your endpoint clean. The interactions endpoint only worries about **receiving and verifying requests**, while `handleCommand` takes care of the **bot’s behavior and responses**. This separation makes it much easier to add new commands later—just extend the `if`/`else` blocks or switch to a more sophisticated command router if you want.

It's optional but also helpful to write helper functions at `lib/discord/helpers.ts` to handle discord-specific tasks such as getting all users in a server. You might have to reuse these often. Here are the two I created:

```ts
export async function getUserProfile(userId: string, guildId: string) {
  const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
    },
  })
  return res.json()
}

export async function getAllGuildMembers(guildId: string) {
  const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`, {
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
    },
  })
  return res.json()
}
```

## Registering Commands

After setting up the interactions endpoint and the command handler, the final piece to make your bot functional is registering the slash commands with Discord. Slash commands need to be explicitly registered so Discord knows they exist and can display them to users in the client. I handled this using the @discordjs/rest library. This is a script that you'll run directly in your command line before deploying your bot. If you add more commands going forward, you'll need to edit and run this script again.

```ts
import { REST } from '@discordjs/rest'
import { Routes } from 'discord-api-types/v10'
import readline from 'readline'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()))
  })
}
 
async function main() {
  try {
    const DISCORD_TOKEN = await ask('Enter your Discord Bot Token: ')
    const DISCORD_APPLICATION_ID = await ask('Enter your Discord Application ID: ')

    if (!DISCORD_TOKEN || !DISCORD_APPLICATION_ID) {
      throw new Error('Both token and application ID are required!')
    }

    // EDIT THE COMMANDS HERE 
    const commands = [
      {
        name: 'ping',
        description: 'Replies with Pong!',
      },
    ]

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN)

    console.log('Registering slash commands...')

    await rest.put(
      Routes.applicationCommands(DISCORD_APPLICATION_ID),
      { body: commands }
    )

    console.log('✅ Slash commands registered!')

  } catch (err) {
    console.error('❌ Error registering commands:', err)
  } finally {
    rl.close()
  }
}

main()
```
This script is interactive: it prompts you for your **bot token** and **application ID** so you don’t have to hard-code sensitive information. Once entered, it creates an array of commands—currently just `ping`, but you can add as many commands as you want here. Each command includes a `name` and `description`, which are what Discord displays to users when they type `/` in the client.

The REST client from `@discordjs/rest` handles sending these commands to Discord via the API. Specifically, the script calls `Routes.applicationCommands(DISCORD_APPLICATION_ID)` to register the commands globally. Once this is done, Discord knows about your commands, and they become available across all servers where your bot is installed. The console logs provide feedback so you know whether the registration was successful or if there were errors.

This step is crucial because even though your bot can receive interactions and respond correctly, **slash commands won’t appear in Discord until they’re registered**. By keeping this script separate from the bot’s main code, you can safely update commands without touching the runtime logic.

For reference, the Discord documentation on registering commands explains the process in more detail: [Registering Slash Commands](https://discord.com/developers/docs/interactions/application-commands#registering-a-global-application-command).

## Continuing From Here

At this point, our setup is done, and I can build out the functionality of my bot over the existing boilerplate. I can build practically anything from here If you've been following along, here are a few additional tips to help you continue from here.

If you want to use supabase in your discord bot, you can import `supabase` from `@/lib/supabase/bot.ts` and use it the way you would use it in a regular web application, for example:

```ts
// lib/discord/commands.ts
import { supabase } from '@/lib/supabase/botClient'
import type { APIChatInputApplicationCommandInteraction } from 'discord-api-types/v10'

export async function handleCommand(interaction: APIChatInputApplicationCommandInteraction) {
  const { name, options } = interaction.data

  if (name === 'add-score') {
    const user = interaction.member?.user?.username || 'Anonymous'
    const score = options?.find((opt) => opt.name === 'points')?.value

    if (!score) {
      return new Response(
        JSON.stringify({
          type: 4,
          data: { content: '⚠️ You must provide a score!' },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Insert score into Supabase
    const { error } = await supabase.from('scores').insert([{ username: user, points: score }])

    if (error) {
      return new Response(
        JSON.stringify({
          type: 4,
          data: { content: `❌ Failed to add score: ${error.message}` },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({
        type: 4,
        data: { content: `✅ Added ${score} points for ${user}!` },
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  }

  return new Response(
    JSON.stringify({
      type: 4,
      data: { content: '❌ Unknown command' },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  )
}
```

If you want to dynamically generate your invite link and display it on say, `app/page.tsx`, so users can use it, you can do it like this:

```ts
const clientId = process.env.NEXT_PUBLIC_DISCORD_APPLICATION_ID
const permissions = 8 // Admin
let inviteUrl = ''
if (clientId && permissions) inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&scope=bot%20applications.commands`
```

The code pulls the bot’s application ID from environment variables and sets the permissions integer (in this case 8 for full admin). It then constructs the OAuth2 URL with the proper scope for both the bot and its slash commands. You can render this inviteUrl as a clickable button or link in your frontend, so users can add your bot to their servers with a single click.

This dynamic approach is especially useful if your bot is deployed across multiple environments or if permissions ever change—you won’t have to manually update the link every time.

## Deployment

This is our reward. Deployment is so simple

Once the bot is fully built and tested locally, the next step is deployment. Since this setup uses Next.js edge functions for the interactions endpoint, deployment is straightforward and fully serverless. I deployed my project to Vercel, which allows edge functions to run globally with minimal latency and no need for a persistent server. This is perfect for a bot that only needs to respond when Discord sends an interaction.

Before deploying, I made sure all environment variables were set in Vercel. This includes the Discord application ID, public key, bot token, and Supabase keys—both the public anon key and the service role key. Vercel allows you to define these securely in the Project Settings → Environment Variables section, which keeps sensitive information out of your codebase.

Deploying is as simple as connecting your GitHub repository to Vercel, selecting the project, and hitting Deploy. Vercel will build the Next.js app, including the edge function at api/discord, and make it available at a public URL. This URL is exactly what you use for the Interactions Endpoint in the Discord Developer Portal.

Because the endpoint runs as an edge function, there are no cold starts to worry about and no server maintenance. The bot is now live, fully serverless, and ready to respond to users across the world. You can update commands, tweak Supabase logic, or even add new pages to your frontend, and redeploy seamlessly without touching any traditional server infrastructure. The best part is? All your code - website, server - is all in one folder, deployed in one place.

## Important Limitations

Now it's important to have a reality-check here. While the interaction-based model is incredibly convenient for serverless hosting, it does come with some important limitations that are worth noting. Unlike traditional bots that maintain a persistent WebSocket connection to Discord, an edge-function bot **cannot listen to arbitrary events** in real time. This means you **cannot** react to things like:

* Users joining or leaving a server
* Messages being sent in channels
* Presence updates, typing indicators, or voice state changes

In short, your bot only “wakes up” when a **user triggers an interaction**, such as a slash command, button click, or select menu. Any functionality that depends on passively monitoring the server or reading messages will not work with this model.

Another limitation is that commands and responses must complete quickly. Since edge functions are stateless and serverless, long-running operations or heavy computations can cause timeouts or increased latency. If you need to do something more complex, it’s often better to offload that work to a background job or a separate serverless function that doesn’t block the response to Discord.

Despite these restrictions, this model works perfectly for **command-driven bots**, dashboards, and admin tools, and it keeps hosting costs at zero. It’s a trade-off: you give up passive event listening, but gain simplicity, scalability, and a fully serverless architecture.

## Useful Links & References

To help you explore further and build your bot even faster, here are some resources I relied on while putting this project together:

* **Discord Developer Portal** – Where you create your bot, grab credentials, and configure interactions: [https://discord.com/developers/applications](https://discord.com/developers/applications)
* **Discord Interactions Documentation** – Explains request verification, response types, and interaction objects: [https://discord.com/developers/docs/interactions/receiving-and-responding](https://discord.com/developers/docs/interactions/receiving-and-responding)
* **Discord Slash Commands Guide** – How to structure, register, and use slash commands: [https://discord.com/developers/docs/interactions/application-commands](https://discord.com/developers/docs/interactions/application-commands)
* **Supabase Docs** – Full reference for authentication, database, and service-role client setup: [https://supabase.com/docs](https://supabase.com/docs)
* **Next.js Edge Functions** – Learn how to build and deploy serverless endpoints globally: [https://nextjs.org/docs/api-reference/edge-runtime](https://nextjs.org/docs/api-reference/edge-runtime)
* **@discordjs/rest** – Library for registering commands via the Discord API: [https://discord.js.org/#/docs/rest/main/general/welcome](https://discord.js.org/#/docs/rest/main/general/welcome)

With these links and your code ready, you now have a fully serverless, interactive Discord bot that can handle commands, talk to a database, and be deployed with zero maintenance. From here, the possibilities are endless—you can add leaderboards, user profiles, dynamic dashboards, or anything else your bot brain can dream up.

That's it for now. I hope you found this useful. Did you read the entire thing? Either way here's the full boilerplate so you either didn't or don't need to: [https://github.com/emjjkk/nextjs-discordbot-template](https://github.com/emjjkk/nextjs-discordbot-template).

And I leave you with a quote from Sun Tzu, paraphrased for conciseness.

> "Ragebait your enemy."


