In this post, I want to explain how to show what you're doing at any given moment in your browser, such as livestreaming on Youtube or playing a game, live on your own webpage. 

A while back, pulling something like this off would’ve been a pain. I’d have to go through official API docs (like Spotify’s) just to figure out if it was even possible. Half the time, it wasn’t. And when it was, I’d have to write piles of code for each individual platform — just to show a tiny “Now Watching” block somewhere on my site. It was messy, overkill, and not really worth it for, say, a simple aesthetic touch on a biolink.

But now, there’s a an easier, all-in-one way to do it. One setup to fetch all your activity, with full control over what shows and how it looks.

Let me show you how to do it using everyone’s favorite web framework — NextJS. If you use a different framework, the steps will likely be similar.

## Getting Started with PreMiD

[PreMiD](https://premid.app) is a browser extension that was originally designed to show your live activity on your Discord profile by detecting the tabs open in your browser. It has an open-source community driven list of activities which cover detecting activities from of websites including popular sites such as Netflix, Spotify and Disney Plus, as well as some lesser known ones. It works by detecting what website you have opened in your browser and which page you're on, and allows you to configure it to show only the activities you want, or temporarily turn it off entirely.

Despite being built around Discord rich presence, PreMiD recently added a new feature which now makes it possible to display your activity on anywhere you can embed code. You do, however, still need a Discord account, so if you don't have one already, now is probably a good time to create one.

To get started, you'll want to [install PreMiD](https://premid.app/downloads) on whichever browser you use the most. It is available on Chrome, Edge, Firefox, and Safari, as well as other Chromium-based browsers.

Upon install, you'll see an onboarding page prompting you to connect to your Discord account.

<img width="100%" height="auto" alt="image" src="https://github.com/user-attachments/assets/181a9212-6b5d-4bc7-bc2e-a74018dca41a" />

Tap **Connect with Discord** and click **Authorize**.

<img width="100%" height="auto" alt="image" src="https://github.com/user-attachments/assets/c883b36c-48fb-4ae2-af9e-f35df957daff" />

Once your discord account is connected, PreMiD should already be set up and working. I don't mean to state the obvious but pinning it to your toolbar will be something your future self thanks you for.

If you tap the extension's icon, and tap the settings icon in the top right of a popup, then scroll down, note that there's an option named **Activity Forwarding** and when you enable it, you're given an input field to provide a **Forwarding URL**. We'll come back to this. This is what we'll be using to connect it to our own site.

<img width="100%" height="auto" alt="image" src="https://github.com/user-attachments/assets/15400091-530b-4d21-bbca-cf4c8010a115" />

Now, I don't want to just lay out the steps. Let's take a quick look at exactly how this will look under the hood, so that you'll have a good idea of how this works regardless of what technologies you'll be using.

Each time you start an activity, like watching a video on youtube or reading a webcomic, PreMiD will send a `POST` request to the URL you specified containing JSON data resembling the following:

```json
{
  "active_activity": {
    "application_id": "503557087041683458", // PreMiD's client ID or the activity's client ID
    "name": "YouTube", // The name of the service
    "service": "unknown", // The name of the service (currently set to "unknown")
    "api_version": 0, // The API version of the service (will be populated in future updates)
    "type": 0, // Activity type (0 = Playing, 1 = Streaming, 2 = Listening, 3 = Watching, 5 = Competing)
    "details": "Watching a video", // Optional - First line of the activity
    "state": "Video title", // Optional - Second line of the activity
    "timestamps": { // Optional - Timestamps for the activity
      "start": 1619712000000, // Unix timestamp in milliseconds
      "end": 1619715600000 // Unix timestamp in milliseconds
    },
    "assets": { // Optional - Images for the activity
      "large_image": "https://example.com/logo.png", // Large image key
      "large_text": "YouTube", // Text shown when hovering over the large image
      "small_image": "https://example.com/play.png", // Small image key
      "small_text": "Playing" // Text shown when hovering over the small image
    },
    "buttons": [ // Optional - Up to 2 buttons
      {
        "label": "Watch", // Button text
        "url": "https://youtube.com/watch?v=..." // Button URL
      }
    ]
  },
  "extension": {
    "version": "2.3.0", // Extension version
    "user_id": "123456789012345678", // Discord user ID (if connected) or null
    "api_version": 1 // API version of the activity forwarding feature
  }
}
```

This contains all the information about your currently detected activity, as well as some links and helpful image assets.

When you stop doing that activity, PreMiD will send a POST request with the following JSON body.

```json
{
  "active_activity": null,
  "extension": {
    "version": "2.3.0", // Extension version
    "user_id": "123456789012345678", // Discord user ID (if connected) or null
    "api_version": 1 // API version of the activity forwarding feature
  }
}
```

The awkwardness of this is that instead of us being able to hit an endpoint to fetch our activity on demand, PreMid hits our endpoint to give us the information whenever we start or stop it. They've essentially shifted the responsibility of storing the data onto us, meaning you'll need somewhere (like a small server or database) to store the latest state and serve it to your site.

For the rest of this guide, we'll be using Redis for this.

## Setting up Redis

The easiest way to start a Redis database this is with [Upstash](https://upstash.com). Visit their website and sign in with GitHub or Google. It takes less than a minute, and you'll land on your dashboard. Click **New Database** on the top right of the dashboard to create your Redis instance. Give it a name and pick a region close to you.

<img width="100%" height="auto" alt="image" src="https://github.com/user-attachments/assets/258dcd71-0999-45e2-a8e1-f66e89944bcd" />

When prompted to select a plan, you can go ahead and stick with the free plan. It provides more than we need.

Upon successful creation of the database, we'll be redirected to the newly created dashboard for our new database. Under the section named **Connect**, make sure to copy your **TCP endpoint**. It's important to copy the TCP endpoint and not the HTTPS one, or you may run into unexpected issues when connecting your application otherwise.

<img width="100%" height="auto" alt="image" src="https://github.com/user-attachments/assets/d1cd83a8-1e85-473c-a6ea-a77d2fb52424" />

Paste it in your `.env.local` file as `REDIS_URL`.

## Creating your Endpoint

In your NextJS existing project, you'll want to install the following dependency. (If you don't already have a NextJS project, you can create one by executing `npx create-next-app@latest ./`):

```yaml
npm install --save ioredis
```

Ioredis is a powerful, high-performance Redis client for Node.js.

Next, we'll need to create an API endpoint for PreMiD to send our activity data to. We can do this by creating a new file at `app/api/activity/route.ts` with the following content:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import Redis from 'ioredis';

// Create Redis Client
const redis = new Redis(process.env.REDIS_URL!);

// POST - store activity with 24-hour expiration
export async function POST(request: NextRequest) {
  try {
    const data = await request.json();

    // Store in Redis with 24h TTL
    await redis.set('premid:activity', JSON.stringify(data), 'EX', 86400);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('PreMiD webhook error:', error);
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

// GET - retrieve activity
export async function GET() {
  try {
    const activity = await redis.get('premid:activity');
    const parsed = activity ? JSON.parse(activity) : { active_activity: null };

    return NextResponse.json(parsed);
  } catch (error) {
    console.error('Error fetching activity:', error);
    return NextResponse.json({ error: 'Failed to fetch activity' }, { status: 500 });
  }
}
```

This file defines a Next.js API route that connects to Redis and does two things:
- `POST`: saves your current activity (from PreMiD)
- `GET`: lets your site or app fetch that saved activity later

If you want to test your endpoint on a development server, you can use a tunelling tool like **ngrok** to make your dev server public after you run `npm run dev`:

```yaml
npm install -g ngrok
ngrok http 3000
```

That will then output a public URL like:

```bash
Forwarding  https://pink-cat-1234.ngrok-free.app -> http://localhost:3000
```

In which case, you can configure your forwarding endpoint in PreMiD as `https://pink-cat-1234.ngrok-free.app/api/activity`. Now PreMiD will start sending your current activity as JSON to your local API route. To see if it works, open your development server in your browser and navigate to `api/activity`. You should see JSON displayed something like this:

<img width="100%" height="auto" alt="image" src="https://github.com/user-attachments/assets/f5a6d2e2-b947-4b7b-bc35-87febfd399c1" />

Better yet, go ahead and start an activity, you'll see all the data displayed here.

<img width="100%" height="auto" alt="image" src="https://github.com/user-attachments/assets/63f7875f-6633-4df3-97b7-f40f2ed1945c" />

Now that we have a functioning endpoint to fetch our live activity from, a lot of devs will probably will carry on by themselves here, since displaying data JSON data from a GET request is basic stuff. If that's what you're about to do, thanks for reading this far! Feel free to drop me a message on Discord @e.mjjkk or follow my Github @emjjkk. I hope you found this article to be of value :)

If you still want to see how to display this raw data on your site, then read on.

## Displaying your activity

Now that we can fetch live data of our activity, it's time to display it.

> In my example, I built out the API endpoint as part of my main website, but I left it public, meaning that I can access this same endpoint from other websites too, without having to redo all the steps I completed so far. This might be something you want to do too, especially since PreMiD doesn't allow you (as of November 2025) to input more than one Forwarding URL. Even if they did, why repeat hard work?

I'll be displaying my activity in `app/page.tsx` but the approach is the same anywhere. Since I'm using TS, I'll start by creating an Interface like so.

```typescript
interface Activity {
  active_activity?: {
    name?: string;
    details?: string;
    state?: string;
    assets?: any;
    timestamps?: { start?: number };
  };
}
```

Then, using react's `useState` and `useEffect` utilites, we can fetch and store the activity data from our own endpoint and make it update in periodically like so:

```typescript
const [activity, setActivity] = useState<Activity | null>(null);
  const [loading, setLoading] = useState(true);

  async function fetchActivity() {
    try {
      const res = await fetch("/api/activity");
      const data = await res.json();
      setActivity(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchActivity();
    const interval = setInterval(fetchActivity, 10000); // refresh every 10s
    return () => clearInterval(interval);
  }, []);
```

And we can now use the activity state to simply display the data in our React JSX content. From here it's a matter of creativity and personal touch, But here's a full example of how I implemented my own fancy-pants live activity `page.tsx`, in case you're interested. I used TailwindCSS. (You'll need to install `framer-motion` and `react-icons` to make it work).

```typescript
"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { LuMusic4, LuPlay, LuPause, LuMonitor, LuLoaderCircle } from "react-icons/lu";

interface Activity {
  active_activity?: {
    name?: string;
    details?: string;
    state?: string;
    assets?: any;
    small_image?: string;
    timestamps?: { start?: number };
  };
}

export default function HomePage() {
  const [activity, setActivity] = useState<Activity | null>(null);
  const [loading, setLoading] = useState(true);

  async function fetchActivity() {
    try {
      const res = await fetch("/api/activity");
      const data = await res.json();
      setActivity(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchActivity();
    const interval = setInterval(fetchActivity, 10000); // refresh every 10s
    return () => clearInterval(interval);
  }, []);

  const act = activity?.active_activity;

  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-neutral-950 via-neutral-900 to-neutral-950 text-white p-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-sm bg-neutral-800/40 border border-neutral-700 rounded-2xl p-6 backdrop-blur-sm shadow-xl"
      >
        <h1 className="text-lg font-bold mb-5 text-center">
          {loading ? "Loading activity..." : "Khaiyadsai's Current Activity"}
        </h1>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <LuLoaderCircle className="animate-spin text-3xl text-neutral-400" />
          </div>
        ) : act ? (
          <motion.div
            key={act.name}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="flex flex-col items-center text-center space-y-3"
          >
            <div className="relative flex items-center flex-col ">
              {act.assets?.large_image ? (
                <img
                  src={act.assets?.large_image}
                  alt="activity cover"
                  className="w-2/4 h-fit rounded-xl shadow-md rounded-md border border-neutral-600"
                />
              ) : (
                <div className="w-28 h-28 rounded-xl bg-neutral-700 flex items-center justify-center text-4xl">
                  <LuMusic4 />
                </div>
              )}

              {act.small_image && (
                <img
                  src={act.small_image}
                  alt="small"
                  className="absolute -bottom-2 -right-2 w-10 h-10 rounded-full border-2 border-neutral-800"
                />
              )}
            </div>

            <div>
              <p className="text-lg font-semibold mb-3">{act.name}</p>
              <p className="text-neutral-300 text-md mb-2">{act.details}</p>
              <p className="text-neutral-400 text-sm">{act.state}</p>
            </div>

            <div className="flex items-center gap-2 text-neutral-400 mt-2">
              {act.timestamps?.start ? (
                <>
                  <LuPlay />
                  <LiveTimer start={act.timestamps.start} />
                </>
              ) : (
                <LuMonitor />
              )}
            </div>
          </motion.div>
        ) : (
          <div className="text-center text-neutral-500 py-10">
            <LuPause className="mx-auto text-3xl mb-2" />
            <p>No active activity right now</p>
          </div>
        )}
      </motion.div>
    </main>
  );
}

// live timer component
function LiveTimer({ start }: { start: number }) {
  const [elapsed, setElapsed] = useState("");

  useEffect(() => {
    const update = () => {
      const seconds = Math.floor((Date.now() - start) / 1000);
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      setElapsed(`${mins}:${secs.toString().padStart(2, "0")}`);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [start]);

  return <span>{elapsed}</span>;
}
```

And here's how it looks:

<img width="100%" height="auto" alt="image" src="https://github.com/user-attachments/assets/4137d73e-6d1d-400f-bd68-53956c6b31e2" />

Done. We now have a page that shows our live activity, and better yet, we have a reusable endpoint to show our live activity on any website.

## Links & Additional Notes

💻 Source Code [https://github.com/emjjkk/nextjs-premid-redis-example](https://github.com/emjjkk/nextjs-premid-redis-example)

🔗 PreMiD [https://premid.app/](https://premid.app/)

🔗 UpStash [https://upstash.com/](https://upstash.com/)

**More customization.** If you want to have full control over exactly which activities show and how it displays, all of that can be done in the UI of the PreMiD extension. There is also a [PreMiD Activity Library](https://premid.app/library) where you can select detection for over 1000 websites. I encourage you to explore these, there are a lot more features of PreMiD I haven't covered.

**Performance pitfalls.** PreMiD can cause severe lag in low-end devices, meaning that your browser would become slow, or you may have trouble playing videos from youtube.

**Limitations.** You probably figured this out by now, but this will only work for browser activities. Anything outside of that (e.g. listening to Spotify on your mobile app, using VSCode Desktop) will not be detected.

**Discord Activity.** As of November 2025, your activity will inevitably also show in your discord profile as well as on your website, and you cannot really separate it to have one but not the other. Not a problem, but something to know.

Thanks for reading! I hope you found this basic guide of some value. Please consider following for more articles like this in the future. I plan to be writing these on a weekly basis. Hopefully I'm a man of my word.







