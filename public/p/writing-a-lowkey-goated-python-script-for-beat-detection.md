# Writing a Lowkey Goated Python Script To Detect Beats from Audio Files

If you're a developer, this is your sign to build a project you have absolutely no clue about, because you will learn it on the way.

I have a hobby that most people in my circle don't know about. I make montage edits. Not the cringe slideshows-with-transitions kind — the actual cinematic, cut-to-the-beat, fan-edit kind that you see floating around on Twitter and YouTube with three million views and no context about who made them. My main subjects are celebrities I go through phases obsessing over, and right now that's Karina from aespa. If you know, you know. If you don't, go watch their stages and come back in two hours when you've lost your mind a little.

The tool I use is DaVinci Resolve, which is genuinely one of the most impressive pieces of software you can get for free. The color grading alone is industry standard. But here's the thing — making a good montage edit isn't really about color grading. It's about the sync. The whole visual language of a well-made edit is built on cuts that land exactly on the beat, transitions that breathe in the spaces between hits, moments that punch forward right when the bass drops. When it works, it feels almost physical to watch. When it doesn't, the whole thing feels sloppy even if every individual clip looks beautiful.

And syncing manually is genuinely painful. You're scrubbing through a waveform, dropping markers by hand, trying to feel where the beat is while also judging whether the clip length is right, whether the transition makes sense, whether the energy is building correctly. It's creative decision-making stacked on top of tedious mechanical work, and the mechanical part really shouldn't be taking your attention at all.

Solutions exist. There are plugins, there are online tools, there are people selling Resolve templates with "auto-sync" features. I tried a bunch of them. Every single one had the same problem: they detect beats in regular intervals. They find the tempo — let's say 128 BPM — and they drop a marker every 0.468 seconds like clockwork, all the way through the track. Clean, evenly spaced, technically correct, completely useless for what I actually need.

Because here's the thing about the tracks I edit to. The parts that matter — the actual moments you cut to — aren't evenly spaced. There's a buildup, a drop, a breakdown, a build again. There are snare hits that deserve a cut and kick drums that deserve a cut and hi-hat patterns that you ride for a sequence and then a single heavy transient that you slam a clip change into. The interesting musical information is not uniformly distributed across the timeline. It's clustered, irregular, shaped by the song's arrangement, and that's exactly what makes it work emotionally.

I wasn't asking for much. I wasn't looking for an AI-powered integrated plugin that analyzes my timeline and auto-edits my footage. I didn't want something that talks to Resolve's API or requires a subscription or installs a service that runs in the background. All I wanted was: give me a list of timestamps. Just timestamps, in seconds, marking the moments in this audio file that are worth cutting to. I'll import them into Resolve as markers and take it from there. The output format I needed was an EDL file — Edit Decision List — which is a plain text format that professional NLEs have understood for decades.

That felt simple enough that I figured I could just build it myself. Famously, these are the projects that teach you the most.


## The Repo Somehow Took Off

Before I get into the code, I want to mention something that still kind of baffles me. This repo — a small Python utility script I built for myself during queue timers — is one of the only things I've ever put on GitHub that got beyond five stars without me doing any promotion whatsoever. No post, no Reddit thread, no newsletter mention. I didn't even write a great README initially. It just quietly accumulated stars from people who apparently had the exact same problem I had, which is a better form of validation than anything you can engineer. There's a whole category of tools that exist in this gap between "I need this" and "nothing adequate exists" and when you build in that gap and share it, people find you eventually.

Anyway. The code.

---

## Step 1: Starting with Librosa

The first version I wrote used Librosa, which is the standard Python library for audio and music analysis. It's well-documented, pip-installable, and covers a huge range of use cases from beat tracking to spectral analysis to mel-frequency cepstral coefficients (which I learned is a real thing and not something I made up).

Installation is one command:

```bash
pip install librosa numpy
```

The Librosa script — `librosa.py` in the repo — is the simpler of the two scripts and a good place to start if you want to understand what's actually happening before you reach for a more powerful tool.

The entry point takes the audio file path and a few optional arguments via argparse:

```python
parser = argparse.ArgumentParser(
    description="Detect beat timestamps from audio and create EDL markers"
)
parser.add_argument("file", help="Path to audio file (mp3/wav)")
parser.add_argument("--out", help="Output text file", default="output/beats.txt")
parser.add_argument("--edl", help="Output EDL file", default="output/markers.edl")
parser.add_argument("--fps", type=int, default=30, help="Timeline FPS")
parser.add_argument("--method", default="beat", choices=["beat", "onset", "both"],
                   help="Detection method: beat (rhythmic), onset (transients), or both")
```

The `--method` argument is the most important one. There are two fundamentally different things you might want to detect in an audio file: rhythmic beats (the steady pulse of the music, tempo-based) and onsets (transient events — a snare hit, a clap, a crash, a sound starting). For editing montages, onsets are usually more useful. But I exposed both and a combined mode because different tracks call for different approaches.

Loading audio with Librosa is one line:

```python
y, sr = librosa.load(args.file)
```

`y` is the audio time series as a NumPy array. `sr` is the sample rate — typically 22050 Hz when loaded through Librosa's default resampler, regardless of what the original file's sample rate was. Every subsequent Librosa call takes `y` and `sr` as its primary inputs.

Beat detection is also nearly one line:

```python
tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units='time')
tempo_value = tempo[0] if hasattr(tempo, '__len__') else tempo
print(f"Detected tempo: {tempo_value:.1f} BPM")
```

The `units='time'` parameter tells Librosa to return beat positions in seconds rather than frame indices, which is what we want. The `tempo` return value is either a scalar or an array depending on your Librosa version (it changed between versions, hence the `hasattr` check), and it gives you the estimated BPM, which is a nice sanity check to print out. If it says 97 BPM and you know the track is 128, something's off.

Onset detection is similarly concise:

```python
onsets = librosa.onset.onset_detect(
    y=y,
    sr=sr,
    units="time",
    backtrack=True
)
```

The `backtrack=True` parameter here is subtle but meaningful. By default, onset detection finds peaks in the onset strength envelope, which tends to be slightly after the actual moment of attack. Backtracking shifts each onset back to the nearest local minimum before the peak — in other words, it snaps the timestamp to the actual moment the sound started rather than the moment it reached its peak energy. For tight editing, you want the attack, not the peak.

After collecting timestamps from whichever method was chosen, we deduplicate and filter:

```python
beats = sorted(set([round(float(t), 3) for t in beats]))

filtered_beats = []
last_beat = -1
min_gap = 0.1
for beat in beats:
    if beat - last_beat >= min_gap:
        filtered_beats.append(beat)
        last_beat = beat
```

The `round(float(t), 3)` converts everything to millisecond precision before deduplication. Without rounding, timestamps like `1.3999999999` and `1.4000000001` would be treated as different events. The minimum gap filter (100ms by default) removes cases where beat tracking and onset detection both fired on the same event and ended up slightly offset from each other.

---

## The EDL Format

The output format that actually makes this useful for video editing is the EDL file. An EDL is one of the oldest interchange formats in professional video — it dates back to linear tape editing — but every modern NLE still reads it. The format looks like this:

```
TITLE: Timeline Markers
FCM: NON-DROP FRAME

001  001      V     C        00:00:00:03 00:00:00:03 00:00:00:03 00:00:00:03
* FROM CLIP NAME: Marker 1
|M:00:00:00:03|Beat 1
```

Each entry has a sequential number, a reel number (we just use `001` since we're generating markers, not real edit decisions), a track type (`V` for video), a transition type (`C` for cut), and then four identical timecodes. In a real EDL, those four timecodes represent the source in-point, source out-point, record in-point, and record out-point. For markers, we just repeat the single timestamp four times.

The `|M:...|` line is the marker label format that DaVinci Resolve understands when importing EDL files as markers. Get this right and Resolve drops markers at exactly the right positions with labels. Get it wrong and you import nothing or get a confusing error.

Timecode conversion is a straightforward math operation:

```python
def seconds_to_timecode(seconds, fps=30):
    hours   = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs    = int(seconds % 60)
    frames  = int((seconds % 1) * fps)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}:{frames:02d}"
```

The frames component is the fractional second converted to a frame count at your chosen FPS. If your Resolve project is at 24fps and you generate the EDL at 30fps, every marker will be at the wrong position. The `--fps` argument exists for exactly this reason — always match it to your project timeline.

---

## Step 2: The Essentia Upgrade

The Librosa script worked, kind of. Onset detection was quite inconsistent and to be honest, not really good enough for what I originally was building this for. It was finding all the beats, not specifically the important ones. 

For a track with a lot of rhythmic information — lots of drum hits, lots of onsets — the output would have hundreds of markers densely packed through the timeline. That's not useless, but it means you're still doing a lot of manual cleanup in Resolve after importing. You want the beats you actually edit to. Not every snare hit in a 32-bar section — the snare hits that punctuate the musical structure. I had to do some researh to find a better solution, and I came across Essentia. If Librosa is a supra mk4, Essentia is an mk5. Better. More powerful. More complicated.

The Essentia-based script (`essentia.py`) is the answer to that. Essentia is a more heavyweight audio analysis library developed by the Music Technology Group at Universitat Pompeu Fabra in Barcelona. It's more complex to work with, but it gives you much finer-grained control over the detection pipeline and exposes tools that Librosa doesn't, specifically around loudness and onset detection functions.

```bash
pip install essentia numpy
```

The architecture of the Essentia script has four distinct stages that run in sequence: beat tracking, onset detection, loudness filtering, and smart spacing. Let me walk through each one.

---

### Beat Tracking with BeatTrackerMultiFeature

```python
from essentia.standard import BeatTrackerMultiFeature

def detect_beats(audio):
    tracker = BeatTrackerMultiFeature()
    beats, confidence = tracker(audio)
    return [float(b) for b in beats]
```

`BeatTrackerMultiFeature` is Essentia's most accurate beat tracker. As the name suggests, it uses multiple feature streams — spectral flux, loudness, complex spectral difference — and combines them to produce a more robust beat estimate than any single feature alone. It also returns a confidence score, which I'm not using here but could be used to filter out sections where the tracker is uncertain (a breakdown with no drums, for example).

---

### Onset Detection with HFC

The onset detection is more involved and worth understanding in detail:

```python
def detect_onsets(audio, sample_rate=44100, sensitivity='low'):
    frame_size = 2048
    hop_size   = 512

    window     = Windowing(type="hann")
    spectrum_alg = Spectrum()
    odf        = OnsetDetection(method="hfc")
    onset_picker = Onsets()

    odf_values = []

    for frame in FrameGenerator(audio, frameSize=frame_size, hopSize=hop_size, startFromZero=True):
        windowed = window(frame)
        spectrum = spectrum_alg(windowed)
        odf_values.append(odf(spectrum, spectrum))
```

This is a manual signal processing pipeline. Rather than calling a single high-level function, we're building the detection chain ourselves:

1. `FrameGenerator` slices the raw audio into overlapping frames of 2048 samples each, advancing by 512 samples (the hop size) between frames. At 44100 Hz, a 2048-sample frame is about 46ms of audio. The 512-sample hop means consecutive frames overlap by 75%, which gives us good time resolution.

2. `Windowing` applies a Hann window to each frame. Without windowing, the hard edges at the start and end of each frame would introduce spectral artifacts (a phenomenon called spectral leakage). A Hann window tapers the frame to zero at both ends, which eliminates leakage at the cost of some frequency resolution — a well-understood tradeoff in signal processing.

3. `Spectrum` converts the windowed frame from the time domain to the frequency domain via FFT. Each frame becomes a vector of magnitudes at different frequencies.

4. `OnsetDetection(method="hfc")` computes the High Frequency Content of each spectrum. HFC is a measure of how much energy is concentrated in the high-frequency bins of the spectrum. Onsets — particularly percussive transients like snare hits and claps — cause sudden bursts of high-frequency energy, so HFC peaks reliably at onset moments.

The ODF (Onset Detection Function) gives us a 1D array of values over time, one per frame. We then normalize it and apply a sensitivity threshold:

```python
odf_array = np.array(odf_values)
if len(odf_array) > 0 and odf_array.max() > 0:
    odf_array = odf_array / odf_array.max()

    thresholds = {
        'very_low': 0.6,
        'low':      0.4,
        'medium':   0.2,
        'high':     0.1
    }
    threshold = thresholds.get(sensitivity, 0.4)
    odf_array[odf_array < threshold] = 0
```

Normalizing to 0–1 and then zeroing out values below the threshold means we're keeping only the frames where ODF was in the top percentile relative to the song's own dynamics. At `very_low` sensitivity, we keep only the frames where ODF exceeded 60% of its maximum — only the sharpest, most dramatic transients. At `high` sensitivity, anything above 10% of maximum qualifies, which picks up subtler hits.

The threshold values were determined empirically. I ran the script against a bunch of tracks I actually edit to and tuned the numbers until the output at each sensitivity level felt right for its intended use case.

---

### Loudness Filtering

This is the stage that makes Essentia meaningfully better than the Librosa version for my use case:

```python
def filter_by_loudness(audio, times, sample_rate=44100, percentile=70):
    frame_size = 4096
    hop_size   = 2048
    
    loudness_alg = Loudness()
    loudness_values = []
    time_stamps = []
    
    for i, frame in enumerate(FrameGenerator(audio, frameSize=frame_size, hopSize=hop_size, startFromZero=True)):
        loudness_values.append(loudness_alg(frame))
        time_stamps.append(i * hop_size / sample_rate)
    
    threshold = np.percentile(loudness_values, percentile)
    
    filtered = []
    for t in times:
        idx = min(range(len(time_stamps)), key=lambda i: abs(time_stamps[i] - t))
        if loudness_values[idx] >= threshold:
            filtered.append(t)
    
    return filtered
```

This function builds a loudness profile of the entire track — a vector of loudness measurements at regular intervals. Then, for each candidate marker timestamp, it finds the nearest loudness measurement and checks whether it exceeds the percentile threshold.

At the default `--loudness 70`, we keep only markers that fall in moments at or above the 70th percentile of loudness for the track. That means we're throwing away 70% of the track by loudness and only marking the top 30% by energy level. For EDM, drops, and impact moments, this is almost exactly right — the musical events worth cutting to are the loud ones. Builds, breakdowns, and quiet sections generate few or no markers.

The percentile threshold rather than an absolute threshold is important. Using an absolute dB threshold would work differently on a heavily compressed track versus a dynamically rich orchestral recording. The percentile is self-calibrating — it's always relative to the track's own dynamic range, not some external reference.

---

### Smart Spacing

Even after loudness filtering, you can still end up with clusters of markers that are too close together to be useful:

```python
def smart_spacing(times, min_gap=0.5):
    if not times:
        return []
    
    spaced = [times[0]]
    for t in times[1:]:
        if t - spaced[-1] >= min_gap:
            spaced.append(t)
    
    return spaced
```

This is a greedy algorithm that walks through the sorted timestamp list and keeps a timestamp only if it's at least `min_gap` seconds after the last kept timestamp. The default is 500ms. You generally can't cut faster than about 12 frames at 24fps and have it register as a distinct cut rather than a flash — and you usually don't want to be anywhere near that limit. Half a second gives you a minimum clip length that's still fast but actually visible.

---

### Snapping Onsets to Beats

The final processing step is one of the subtler ideas in the script:

```python
def snap_onsets_to_beats(beats, onsets, snap_threshold=0.08):
    snapped = set(beats)

    for onset in onsets:
        if not beats:
            snapped.add(onset)
            continue
        nearest_beat = min(beats, key=lambda b: abs(b - onset))
        if abs(nearest_beat - onset) <= snap_threshold:
            snapped.add(nearest_beat)
        else:
            snapped.add(onset)

    return sorted(snapped)
```

Beat tracking and onset detection can find the same musical event at slightly different timestamps. Beat tracking might place an event at 1.400s; onset detection might place it at 1.387s. If you keep both, you get two markers 13ms apart that both represent the same hit, and importing both into Resolve would just be noise.

The snap function says: if an onset is within 80ms of a beat, snap it to the beat's position. The beat tracker tends to be temporally more accurate for periodic events, so when there's a near-match, we prefer the beat's timestamp. If the onset is more than 80ms from any beat, it's probably a genuine transient that the beat tracker missed, so we keep it at its own position.

The combined output — beats plus snapped onsets — goes through the loudness filter and spacing filter before becoming the final marker list.

---

## Using It

The basic usage is minimal:

```bash
# Librosa version — beats only
python librosa.py song.mp3

# Librosa version — onsets (transients), better for editing
python librosa.py song.mp3 --method onset

# Essentia version — smart drop/hit detection
python essentia.py song.mp3

# Essentia — tuned for EDM with major drops only
python essentia.py edm_track.wav --sensitivity very_low --loudness 85 --min-gap 1.0

# Essentia — denser markers, good for fast-cut sections
python essentia.py song.wav --sensitivity medium --loudness 60 --min-gap 0.3
```

The output goes to `output/beats.txt` (raw timestamps, one per line) and `output/markers.edl` (the EDL file for Resolve). In DaVinci Resolve, you import the EDL as timeline markers via File → Import → Timeline Markers from EDL, and you get a marker at every detected beat. Then you just cut to the markers.

The first time I ran it against one of my actual edit tracks and imported the result into Resolve, I had maybe 30 markers across a 3-minute song, all sitting on meaningful musical moments — the drops, the main snare hits, the transition points. No cleanup needed. It saved a genuinely embarrassing amount of time.

---

## What's Next, Maybe

It'd be cool if I could turn this into a web app. The honest answer is that I'm thinking about it, but I'm not willing to invest in it yet. The Python script works, and it works well enough for my own use that there's no urgent personal itch to scratch. A web app would mean file upload handling, probably some server-side processing (or figuring out how to run audio analysis in the browser, which is its own rabbit hole), a UI that doesn't require touching a terminal, and the general overhead of actually deploying and maintaining something. That's a real project. I'm not sure if I have the willingness to do that yet.

But the fact that the repo is sitting at where it is, with zero promotion and a specific enough use case that I genuinely didn't expect anyone else to need it, is the kind of signal worth paying attention to. If enough people are finding this organically, maybe there's something worth building here.

For now though, it does exactly what I needed it to do. The Karina edits are in sync enough and create a positive feedback loop of obsession. That's enough.
