Sometimes, I want to download music onto an SD card, so that I can insert it into my wireless headphones and listen to it offline, on the go. Yes, some of us still exist in this world. Weirdly enough, something as easy as downloading music has become an awkward and cumbersome task. Spotify, for example, hides downloads behind a paywall. Random sites on the internet are clapped with sketchy ads, autoplaying popups, and questionable redirects. It’s messy. So, like any self-respecting developer who’s just trying to vibe to some music, I decided to build my own.

> Before I go any further, quick disclaimer — this is for educational purposes and personal use only. I do not encourage piracy or illegal distribution of copyrighted material. Always try to respect and support artists and creators by using legal channels to access music whenever possible, and don’t ever use applications like this as a means to illegally redistribute content.

With that out of the way, let’s build a YouTube downloader. The goal is to be able to search videos directly (because copying and pasting links is just not it), but also handle direct links when we do have them. The results should show thumbnails and basic details, and from there we should be able to download in either MP3 or MP4 format.

I’m using **Flask**, a lightweight Python web framework, to keep this simple and fast. I’m also keeping dependencies to a minimum — no unnecessary bloat. Ideally, we’ll only have a single Python file and a few HTML and CSS files. Maybe a bit of JavaScript if we really need it. The idea is to keep everything clean, compact, and able to run locally even on a low-spec machine.

## Project Setup

I’m building this on Windows 10 using Command Prompt as my terminal, but the steps are similar for Linux or macOS. Start by creating a new folder anywhere you want — name it whatever you like. Open it in VSCode or your editor of choice, and make sure you have Python 3 installed.

We’ll create a virtual environment, which is best practice for any Python project. It keeps your project’s dependencies isolated and prevents version conflicts. Run the following commands:

```bash
python -m venv .venv
.\.venv\Scripts\activate.bat
```

You should now see `(.venv)` at the start of your terminal prompt, meaning the environment is active. Next, we’ll install the Python packages needed for this project using pip.

```bash
pip install flask youtube-search-python yt_dlp
```

Once that’s done, create a new file called `app.py` and write a basic Flask setup to make sure everything’s working:

```python
from flask import Flask, render_template, request, redirect, url_for, send_file, Response
app = Flask(__name__)

@app.route("/")
def index():
    return "Hello World"

if __name__ == '__main__':
    app.run(debug=True)
```

Now run the server with `python app.py`. You should see a page with “Hello World” written at the top left — that’s Flask confirming we’re live. The base setup’s done. Time to make it do something useful.


## Homepage

The first thing I did was replace the `return "Hello World"` with a call to `render_template`, so Flask could serve an actual HTML file instead of plain text. The homepage will have a simple search box where the user can either type a search term or paste a YouTube link.

```python
@app.route('/')
def index():
    return render_template('index.html')
```

The plan is simple: when a user submits something through that form, we’ll figure out whether it’s a direct link or a search query, then process it accordingly.


## Search and Link Detection

When a user submits the form, we’ll post the input to a route called `/process`. The first thing this route does is check what kind of input we’re dealing with. If it starts with `http://` or `https://`, it’s almost certainly a URL. Otherwise, we’ll treat it as a search query.

If it’s a URL, we’ll just redirect the user to a `/video` route with that link attached as a parameter. That’s where we’ll handle fetching details for the video later. If it’s a search term, we’ll use the `youtube-search-python` library to perform a search and get back a list of video results — titles, thumbnails, durations, etc.

Now, I could’ve used YouTube’s official API for this, but honestly, it’s a headache. It’s rate-limited, requires an API key, and needs setup steps that are totally unnecessary for a personal-use project. `youtubesearchpython` gives clean results instantly — no nonsense. Once we have the results, we’ll render them using a `results.html` template.

```python
from youtubesearchpython import VideosSearch

@app.route('/process', methods=['POST'])
def process():
    user_input = request.form.get('query')
    if not user_input:
        return redirect(url_for('index'))
    
    if user_input.startswith("http://") or user_input.startswith("https://"):
        return redirect(url_for('video', url=user_input))
    else:
        videos_search = VideosSearch(user_input, limit=10)
        results = videos_search.result()['result']
        return render_template('results.html', results=results)
```

## Getting Video Information

Now, let’s handle the `/video` route — the part that takes a YouTube link and displays its info. To make things modular, I created a helper function called `get_video_info(url)` that extracts the video’s metadata using `yt-dlp`. It gives us everything we need — title, duration, thumbnail, uploader, etc. Setting `"skip_download": True` ensures we only fetch the data without actually downloading the file yet.

```python
def get_video_info(url):
    ydl_opts = {"skip_download": True}
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        return ydl.extract_info(url, download=False)
```

Then, in the `/video` route, we grab the URL from the query parameters, call our helper function, and render the info in `video.html`. If the URL is missing or invalid, we just redirect the user back to the homepage and give them the silent treatment.

```python
@app.route('/video')
def video():
    video_url = request.args.get('url')
    if not video_url:
        return redirect(url_for('index'))
    try:
        info = get_video_info(video_url)
    except Exception as e:
        return f"Error retrieving video info: {e}", 500
    return render_template('video.html', info=info)
```

## Downloading the File

Now for the fun and vital part — downloading the actual audio or video. I wrote another helper function called `download_with_yt_dlp` to handle this. Depending on the `type` parameter, it either grabs the best audio stream or the best video stream in MP4 format.

```python
def download_with_yt_dlp(url, type):
    ydl_opts = {
        "format": "bestaudio/best" if type == "audio" else "best[ext=mp4]",
        "outtmpl": "%(id)s.%(ext)s",
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url)
        return ydl.prepare_filename(info)
```

Then we connect this to a route like `/download/<video_id>/<download_type>` that constructs the YouTube URL, calls the function, and sends the file back as a downloadable attachment.

```python
import yt_dlp

@app.route('/download/<video_id>/<download_type>')
def download(video_id, download_type):
    video_url = f"https://www.youtube.com/watch?v={video_id}"

    try:
        filename = download_with_yt_dlp(video_url, download_type)
    except Exception as e:
        return f"Download error: {e}", 500

    if not os.path.exists(filename):
        return "Downloaded file not found.", 404

    return send_file(filename, as_attachment=True, download_name=os.path.basename(filename))
```

## Cleanup

We're almost done with our backend, but as a final touch, we want to make sure that downloaded or half downloaded files dont just pile up in our folder permanently, so we'll write a route to delete them.

```python
# Optional cleanup route to remove downloaded files.
@app.route('/cleanup')
def cleanup():
    for file in os.listdir('.'):
        if file.endswith('.mp4') or file.endswith('.webm') or file.endswith('.m4a'):
            os.remove(file)
    return render_template('done.html')
```

## Javascript to complete the download proccess

I realized that we'll need a bit of Javascript for downloads, so I started by creating a javascript file `static/script.js`.

When a user clicks *Download*, we want a smooth process: disable the button, show a spinner, track progress, trigger the actual file download, and clean up after. For that, I wrote a small JavaScript function called `startDownload`.

```js
function startDownload(videoId, downloadType, button) {
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner animate-spin"></i> Starting download...';
```

The first thing it does is disable the button so the user doesn’t spam it, and replaces the button text with a spinner animation to indicate that the download is starting. It’s a small UX touch, but it makes the app feel responsive instead of dead.

Next, we create an `XMLHttpRequest` — a classic but still reliable way to handle file downloads and track their progress in real time. We open a GET request to our Flask route `/download/<videoId>/<downloadType>` which handles the actual file generation and response on the server side.

```js
const xhr = new XMLHttpRequest();
xhr.open('GET', `/download/${videoId}/${downloadType}`, true);
```

Inside the request, there’s an `onprogress` event listener. This one’s fun — if the browser can measure the download size (`event.lengthComputable`), we calculate how much of the file has been downloaded so far, turn it into a percentage, and update the button text in real time.

```js
xhr.onprogress = function(event) {
    if (event.lengthComputable) {
        const percentComplete = (event.loaded / event.total) * 100;
        button.innerHTML = `<i class="fa-solid fa-spinner animate-spin"></i> Downloading... ${percentComplete.toFixed(2)}%`;
    }
};
```

This is how you get those nice little “Downloading… 45%” progress messages. It doesn’t just make things look cooler — it reassures the user that something *is* happening.

When the request finishes, the `onload` function kicks in. If the response is successful (`xhr.status === 200`), we change the button text to “Download complete!” and create a downloadable link for the file.

```js
xhr.onload = function() {
    if (xhr.status === 200) {
        button.innerText = 'Download complete!';
```

Now, since the response data is binary (a file), we turn it into a **Blob** — basically a chunk of raw data the browser can handle as a file. Then, we create an invisible `<a>` tag, point it to the Blob, give it a filename, and simulate a click. That triggers the actual file download locally without reloading the page.

```js
const blob = new Blob([xhr.response], { type: 'application/octet-stream' });
const link = document.createElement('a');
link.href = window.URL.createObjectURL(blob);
link.download = `${videoId}.${downloadType === 'video' ? 'mp4' : 'm4a'}`;
document.body.appendChild(link);
link.click();
document.body.removeChild(link);
```

After a short delay, we redirect the user to a `/cleanup` route — a nice touch if your backend handles temporary files or cached downloads.

```js
setTimeout(() => {
    window.location.href = '/cleanup';
}, 2000);
```

If something goes wrong during the download or network transfer, the error handlers reset the button and show a failure message. No silent crashes, no confusion.

```js
xhr.onerror = function() {
    button.innerText = 'Download failed';
    button.disabled = false;
};
```

Finally, we set `xhr.responseType = 'blob'` to tell the browser we expect binary data, and send off the request.

## Building the pages with HTML

Now that our backend is well and truly done, it's time to build a frontend so we can actually use our application. As i mentioned earlier, I'll be using plain HTML and CSS with Flask's built-in Jinja templating engine to acheive this.

This is the simple part, and also the part where you can make use of your creativity. I had limited creativity at the precise time of building this application, so I built a very basic UI that is just enough to make the application usable.

I created a `templates` folder (Flask automatically looks here for HTML files) and added four pages — index.html, results.html, video.html, and done.html. Each page has a slightly different role but keeps the same layout and style.

At the top level, I created `.layout.html` which is a very basic template for the rest of the pages. I made sure to import my script and

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{% block title %}{% endblock %}Youtube Downloader</title>
    <script src="https://unpkg.com/@tailwindcss/browser@4"></script>
    <script src="https://kit.fontawesome.com/0e515ca39f.js" crossorigin="anonymous"></script>
    <link rel="stylesheet" href="{{ url_for('static', filename='common.css') }}">
</head>
<body>
    {% block main %}{% endblock %}
    <script src="{{ url_for('static', filename='scripts.js') }}"></script>
</body>
</html>
```

The home page `index.html` extends `.layout.html` is just a search form and also a short reminder of the obvious. It’s where users type a keyword or paste a YouTube link.

```html
{% extends '.layout.html' %}

{% block main %}
<section class="w-full h-screen flex flex-col items-center justify-center">
    <h1 class="text-2xl text-red-500"><i class="fa-brands fa-youtube mr-2 mb-5"></i>emjjkk/yt-downloader</h1>
    <form class="flex items-center justify-center w-[70%] mb-5" action="{{ url_for('process') }}" method="POST">
        <input type="text" name="query" id="query" placeholder="Search or enter Youtube URL" class="px-4 py-2 text-md bg-gray-200 w-3/4 text-center">
        <button type="submit" class="py-2 px-3 text-md bg-red-500 ml-2"><i class="fa-solid fa-arrow-right text-white"></i></button>
    </form>
    <p class="text-sm text-gray-500 text-center">
        For personal use only. Respect Youtube's guidelines, content creators, and don't be shitty.
        <br>In case of technical issues reach out on discord (@e.mjjkk) or try fix it on Github (emjjkk/yt-downloader)
    </p>
</section>
{% endblock %}
```

<img width="100%" height="auto" alt="image" src="https://github.com/user-attachments/assets/db7e8336-1811-4af2-94c4-546b35d3de36" />


The results page is in `results.html`. When users type in a search term, Flask renders this page with the list of videos returned by `youtube-search-python`.

```html
{% extends '.layout.html' %}

{% block title %}Search Results | {% endblock %}

{% block main %}
<section class="w-full min-h-screen md:py-24">
    <section class="md:w-2/4 w-full mx-auto p-2">
        <a href="/" class="text-sm mb-2 block"><i class="fa-solid fa-arrow-left mr-2"></i> Back to homepage</a>
        <h1 class="text-xl mb-10">Search Results</h1>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            {% for video in results %}
            <div class="items-start bg-white">
                <img src="{{ video['thumbnails'][0]['url'] }}" alt="Thumbnail" class="w-full h-auto">
                <div class="pt-2">
                    <h3 class="text-md font-semibold h-[5ch] overflow-y-hidden">{{ video['title'] }}</h3>
                    <p class="text-sm text-gray-500">Duration: {{ video['duration'] }}</p>
                    <p class="text-sm text-gray-500 mb-1">Views: {{ video['viewCount']['short'] }}</p>
                    {% if video['link'] %}
                    <a href="{{ url_for('video', url=video['link']) }}" class="text-sm py-1 px-2 bg-red-500 text-white inline-block rounded">View Details & Download <i class="fa-solid fa-arrow-right"></i></a>
                    {% else %}
                    <a href="{{ url_for('video', url='https://www.youtube.com/watch?v=' + video['id']) }}" class="text-sm py-1 px-2 bg-red-500 text-white inline-block rounded">View Details & Download <i class="fa-solid fa-arrow-right"></i></a>
                    {% endif %}
                </div>
            </div>
            {% endfor %}
        </div>
    </section>
</section>
{% endblock %}
```

It loops over the search results, displays thumbnails, titles, and channel names, and links each one to its /video page. Visually, I used a card layout with a grid display to make it look modern but still lightweight.

Then there's `video.html`. Once a specific video is chosen, this page shows its details and download options (audio or video).

```html
{% extends '.layout.html' %}

{% block title %}{{ info.title }} - {% endblock %}

{% block main %}
<section class="w-full min-h-screen md:py-24">
    <section class="md:w-2/4 w-full mx-auto p-2">
        <a href="/" class="text-sm mb-2"><i class="fa-solid fa-arrow-left mr-2"></i> Back to homepage</a>
        <h1 class="text-xl mb-5">{{ info.title }}</h1>
        <img src="{{ info.thumbnail }}" alt="Thumbnail" class="w-full h-auto mb-5">
        <div class="flex">
            <button id="download-video" class="text-white px-4 py-2 bg-red-500 border-2 border-red-500 mr-2 cursor-pointer hover:bg-white hover:text-red-500" onclick="startDownload('{{ info.id }}', 'video', this)">Download Video (MP4)</button>
            <button id="download-audio" class="text-white px-4 py-2 bg-red-500 border-2 border-red-500 mr-2 cursor-pointer hover:bg-white hover:text-red-500" onclick="startDownload('{{ info.id }}', 'audio', this)">Download Audio</button>
            <button id="toggle-details" class="text-white px-4 py-2 bg-gray-700 border-2 border-gray-700 cursor-pointer hover:bg-white hover:text-gray-700">Show Details</button>
        </div>
        <div class="mb-5">
            <div id="details" class="hidden mt-3 p-3 border border-gray-300 bg-gray-100">
                <p class="text-sm mb-1"><strong>Duration:</strong> {{ info.duration }} seconds</p>
                <p class="text-sm mb-1"><strong>Views:</strong> {{ info.view_count }}</p>
                <p class="text-sm mb-1"><strong>Description:</strong> {{ info.description }}</p>
            </div>
        </div>
    </section>
</section>
{% endblock %}
```

The page uses the JS we discussed earlier to handle downloading and showing/hiding video details. The rest of the content is dynamically filled in by Flask using the info object from yt-dlp.

Last but not least, we have `done.html` to display when a download is complete and help users return to the homepage.

```html
{% extends '.layout.html' %}
{% block title %}Download Successfull! | {% endblock %}
{% block main %}
<section class="w-full h-screen flex flex-col items-center justify-center">
    <p class="text-lg text-gray-500 text-center mb-5">Downloaded successfully!</p>
    <a href="/"><button class="text-white px-4 py-2 bg-gray-700 border-2 border-gray-700 cursor-pointer hover:bg-white hover:text-gray-700">Return to Homepage</button></a>
</section>
{% endblock %}

```

## CSS to finish things off

All of this is tied together by a single stylesheet: style.css, located in a static folder. Again, simplicity was the goal — clean, centered layout.

```css
body {
    background-color: #0e0e10;
    color: #f2f2f2;
    font-family: 'Inter', sans-serif;
    margin: 0;
    padding: 0;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    min-height: 100vh;
}

.container {
    width: 90%;
    max-width: 700px;
    margin-top: 4rem;
    text-align: center;
}

input[type="text"] {
    width: 80%;
    padding: 0.75rem;
    border: none;
    border-radius: 0.5rem;
    margin-right: 0.5rem;
}

button {
    padding: 0.75rem 1.2rem;
    border: none;
    border-radius: 0.5rem;
    background: #ff4747;
    color: white;
    cursor: pointer;
    font-weight: 600;
    transition: 0.2s ease;
}

button:hover {
    background: #ff6363;
}

.results-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
    gap: 1.5rem;
    margin-top: 2rem;
}

.video-card {
    background: #1a1a1d;
    border-radius: 1rem;
    padding: 1rem;
    box-shadow: 0 0 10px rgba(255, 255, 255, 0.05);
    text-align: left;
}

.video-card img {
    width: 100%;
    border-radius: 0.75rem;
}

.hidden {
    display: none;
}
```

And that’s pretty much it — a fully working YouTube downloader built with Flask, yt-dlp, and a bit of JavaScript and CSS. Everything runs locally, doesn’t depend on APIs, and fits into one folder. It’s not a product; it’s a personal utility — something small that solves a real problem without becoming another bloated Electron app.

## It's quite difficult to host this on a production server

Hosting a YouTube downloader on a production server isn’t as straightforward as it sounds. Platforms like YouTube are constantly changing their endpoints, rate limits, and access policies, and most hosting providers don’t love apps that directly fetch and serve large media files.

If you really want to try, I found a way that works sometimes - I used cookies.txt to pass authentication data to yt-dlp so it could bypass bot checks. You can export your cookies from your browser using an extension like “Get cookies.txt,” then drop that file in your project directory. In your Python script, just add the --cookies cookies.txt argument when calling yt-dlp to make sure it uses those credentials when fetching videos. From my experience, this only works within the first few hours of deploying on a production server.

If you know of a better way, brag about it in my Discord DMs: @e.mjjkk

Running the project locally also gives you more control anyway — fewer errors, faster debugging, and no messy server limitations. To make it easier to trigger the app, You can write small helper Python file that runs the Flask app instantly. It’s basically a tiny script sitting on my desktop, so whenever I want to use the downloader, I just double-click it and my local server spins up on localhost:5000 automatically.

```python
import os
import webbrowser
from threading import Timer

def open_browser():
    webbrowser.open_new("http://127.0.0.1:5000")

if __name__ == "__main__":
    # Delay a bit before opening browser to ensure server is up
    Timer(1, open_browser).start()
    os.system("python app.py") # replace this with the path to your app.py
```

This script does two things:

1. **Starts your Flask app** by calling `python app.py`.
   
3. **Automatically opens your browser** to the local server after a short delay.

That means all you have to do is double-click this file and your downloader UI is open and running.

If you’re on Windows, you can go the extra step and make a **shortcut** for `run_app.py`, set its icon (maybe a YouTube logo or something fun), and it’ll feel like a proper mini desktop app.

## Links

🔗 Source code [https://github.com/emjjkk/yt-downloader](https://github.com/emjjkk/yt-downloader)

🔗 yt-dlp [https://github.com/yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp)

If you made it this far, thanks for reading! Have a KitKat.