I haven't posted anything here in an embarrassingly long time. Life happens, motivation dips, you tell yourself you'll write something "when there's something worth writing about," and then six months pass and your portfolio still has tumbleweeds blowing through it. Anyway — I've been trying to fix that. Partly because I actually enjoy writing these things, and partly because a portfolio with zero recent activity looks a little suspicious to anyone who might stumble across it.

So I decided to find something I could build, finish, and write about without it consuming my entire life. The constraint I set for myself was loose but real: it had to be something I could meaningfully start while waiting for a Valorant match queue to pop. Not a weekend project exactly, more like a series of queue-timer projects that accumulated into something real. A few rounds of "okay the game hasn't found a match yet, let me just wire up this one component" — and genuinely, that's how most of this got built. There's something weirdly productive about having a hard stop that could come at any moment.

The thing I landed on was MyDE — a fully browser-based web IDE with a Monaco code editor, a live preview pane, and an AI panel that can rewrite your files based on natural language prompts. Everything stores locally in `localStorage`, nothing phones home, and the only time the network gets involved is when you explicitly ask the AI to do something or push to GitHub. It's a tool I actually wanted to exist, which is usually a good sign.

Here's what the plan looked like before I started writing any code. I wanted a project manager screen where you can create and open projects, an editor view with tabbed code files (HTML, CSS, JS) and a live preview side by side, a Monaco editor because I'm not building a syntax highlighter from scratch, a streaming AI panel at the bottom of the editor that takes natural language and rewrites your files, a ZIP download so you can take your project anywhere, and a GitHub export so you can deploy it to Pages in one click. That's it. No auth, no database, no server. Just a browser app that does one thing well.

This post is a full walkthrough of exactly how I built it, from the initial project scaffold all the way through the final GitHub export feature. I'll show you every file, explain every decision, and be honest about the things I got wrong the first time.



## Step 1: Scaffolding with Vite + React

The very first thing I did was run the Vite scaffolding command. Vite is the obvious choice here — it's fast, it has an excellent dev server with HMR, and the React plugin handles JSX out of the box with no ceremony.

```bash
npm create vite@latest myde -- --template react
cd myde
npm install
```

This gives you the standard Vite+React skeleton: `index.html` at the root, a `src/` directory with `main.jsx` and `App.jsx`, and `vite.config.js`. I immediately gutted `App.jsx` and `index.css` of all the boilerplate (goodbye, spinning React logo) and started with a clean slate.

The `vite.config.js` ended up being almost entirely default, with one important addition:

```javascript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
})
```

That `base: './'` is critically important. Without it, Vite generates asset paths like `/assets/index-abc123.js` (absolute paths from root), which breaks when you deploy the built app to a subdirectory on GitHub Pages or any non-root hosting. Setting it to `'./'` makes all asset paths relative, so the app works wherever you drop the `dist/` folder.

The `index.html` at the root also got a few additions: I added the Google Fonts preconnect tags and the font link for Fraunces and Hanken Grotesk, which are the two typefaces used throughout the app. Fraunces is a high-contrast serif used for headings and stylistic elements; Hanken Grotesk is a clean geometric sans-serif used for all body text and UI chrome.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>MyDE - AI Powered Local IDE</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,100..900;1,9..144,100..900&family=Hanken+Grotesk:ital,wght@0,100..900;1,100..900&display=swap" rel="stylesheet">
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

The font variable axes (`100..900` for weight) let us use any weight from thin to black using a single font file, which is both efficient and flexible. The `opsz` axis on Fraunces controls optical sizing — at small sizes it adjusts letterforms to be more legible, and at large sizes it becomes more expressive.

Then the `main.jsx` is the bare minimum entry point:

```javascript
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

Nothing clever here. `StrictMode` is left in deliberately — it double-invokes effects and renders in development to catch side effects, which is annoying but genuinely useful for catching bugs in hooks.



## Step 2: The Dependencies

Before writing any component code, I installed all the packages I knew I'd need:

```bash
npm install @monaco-editor/react fflate lucide-react react-icons uuid
```

Let me explain each choice. `@monaco-editor/react` is the Monaco editor — the same editor that powers VS Code — wrapped in a React component. It handles syntax highlighting, auto-completion, bracket matching, and about a thousand other things you'd otherwise spend months building. `fflate` is a zero-dependency, high-performance JavaScript zip/gzip library that runs entirely in the browser — I use it to let users download their project as a ZIP file. `lucide-react` and `react-icons` are icon libraries; I ended up using both because `react-icons` gave me access to the Feather and Lucide icon sets through a single package, and I later wanted some specific icons from Lucide that I imported directly. `uuid` is the `uuid` package, specifically for generating v4 UUIDs to give each project a unique ID in localStorage.

The `package.json` dependencies section ended up looking like this:

```json
{
  "dependencies": {
    "@monaco-editor/react": "^4.7.0",
    "fflate": "^0.8.2",
    "lucide-react": "^0.577.0",
    "react": "^19.2.4",
    "react-dom": "^19.2.4",
    "react-icons": "^5.6.0",
    "uuid": "^13.0.0"
  }
}
```

React 19 is used here, which includes the new concurrent features and some improvements to the `use` hook, though MyDE doesn't lean on any of the most cutting-edge React 19 APIs — it's largely straightforward React with hooks.



## Step 3: The Storage Layer

Before building any UI, I wrote the entire storage layer in `src/storage.js`. This is the backbone of the app. Everything persists here; lose this file and the app stops working. I wanted it to be simple, synchronous (since localStorage is synchronous by nature), and to serve as the single source of truth for all project data.

The design is a simple key-value store built on top of `localStorage`. Each project gets a UUID, and its metadata (name, creation date, update date) is stored at the key `vibe_project_{id}`. The actual file contents (HTML, CSS, JS) are stored separately at `vibe_file_{id}_html`, `vibe_file_{id}_css`, and `vibe_file_{id}_js`. A top-level list of project IDs is stored at `vibe_projects` as a JSON array.

```javascript
import { v4 as uuidv4 } from 'uuid'

const PROJECTS_KEY = 'vibe_projects'
const PREFIX = 'vibe'

export function getAllProjects() {
  const ids = JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]')
  return ids
    .map(id => JSON.parse(localStorage.getItem(`${PREFIX}_project_${id}`) || 'null'))
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function createProject(name = 'Untitled Site') {
  const id = uuidv4()
  const project = { id, name, createdAt: Date.now(), updatedAt: Date.now() }
  
  const ids = JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]')
  localStorage.setItem(PROJECTS_KEY, JSON.stringify([...ids, id]))
  localStorage.setItem(`${PREFIX}_project_${id}`, JSON.stringify(project))
  
  // seed default files
  localStorage.setItem(`${PREFIX}_file_${id}_html`, DEFAULT_HTML)
  localStorage.setItem(`${PREFIX}_file_${id}_css`, DEFAULT_CSS)
  localStorage.setItem(`${PREFIX}_file_${id}_js`, DEFAULT_JS)
  
  return project
}
```

The `filter(Boolean)` call in `getAllProjects` is a small safeguard against orphaned IDs — if somehow an ID is in the list but the corresponding project object is missing from localStorage, we silently skip it rather than crashing with a JSON parse error on `null`. The `.sort((a, b) => b.updatedAt - a.updatedAt)` ensures the most recently modified project always appears at the top.

Each new project is seeded with default files. The default HTML is a clean, minimal starter page that demonstrates the expected file structure — it links `common.css` and loads `scripts.js`, so the user understands how the three files connect:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to MyDE</title>
  <link rel="stylesheet" href="common.css" />
</head>
<body>
  <main class="hero">
    <h1>Build with MyDE</h1>
    <p>
      MyDE lets you write code, preview instantly, and use AI help in one simple workspace.
      Everything is stored locally and never leaves your device.
    </p>
  </main>
  <script src="scripts.js"></script>
</body>
</html>
```

The `saveFile` function is deliberately lightweight — it writes the content and immediately calls `updateProjectMeta` to bump the `updatedAt` timestamp, which means the project list always stays correctly sorted:

```javascript
export function saveFile(projectId, fileKey, content) {
  localStorage.setItem(`${PREFIX}_file_${projectId}_${fileKey}`, content)
  updateProjectMeta(projectId, {})  // bumps updatedAt
}
```

The settings (API key, model, endpoint) are stored separately under `vibe_settings` as a single JSON object. There's no encryption on the API key — it's stored in plain text in localStorage, which is a deliberate trade-off. Encrypting it would require a key, and that key would have to live somewhere equally accessible, making the encryption security theater. The real protection is that localStorage is scoped to the origin and inaccessible to other origins. We do prominently tell the user that the key never leaves their device except to their configured LLM endpoint.



## Step 4: The Settings Context

With storage defined, I needed a way to make settings available throughout the component tree without prop-drilling. This is a classic React Context use case, and I kept it minimal.

```javascript
// src/contexts/SettingsContext.jsx
import { createContext, useContext, useState, useCallback } from 'react'
import { getSettings, saveSettings } from '../storage'

const SettingsContext = createContext(null)

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(() => getSettings())

  const updateSettings = useCallback((patch) => {
    setSettings(prev => {
      const next = { ...prev, ...patch }
      saveSettings(next)
      return next
    })
  }, [])

  return (
    <SettingsContext.Provider value={{ settings, updateSettings }}>
      {children}
    </SettingsContext.Provider>
  )
}

export const useSettings = () => useContext(SettingsContext)
```

The `useState(() => getSettings())` initializer uses the lazy initialization form — the function is only called once on mount rather than every render, which matters since `localStorage.getItem` is a synchronous DOM call. The `useCallback` on `updateSettings` ensures the function reference is stable across renders, which is important because it's passed as a prop into modals and panels that might otherwise re-render unnecessarily.

The `App.jsx` wraps everything in this provider:

```javascript
// src/App.jsx
import { useState } from 'react'
import { SettingsProvider } from './contexts/SettingsContext'
import ProjectManager from './components/ProjectManager'
import Editor from './components/Editor'

export default function App() {
  const [activeProject, setActiveProject] = useState(null)

  return (
    <SettingsProvider>
      {activeProject
        ? <Editor
            project={activeProject}
            onClose={() => setActiveProject(null)}
          />
        : <ProjectManager onOpen={setActiveProject} />
      }
    </SettingsProvider>
  )
}
```

This is the entire routing logic of the app. There's no `react-router-dom`, no URL-based routing. The app has exactly two "pages" — the project manager and the editor — and a single piece of state (`activeProject`) determines which one renders. When a project is selected in the manager, `setActiveProject` is called with the project object, and the `Editor` mounts. When the user presses the back button in the editor, `onClose` fires, which sets `activeProject` back to `null`, and the `ProjectManager` re-mounts (it calls `getAllProjects()` fresh on every mount, so the list is always up to date).



## Step 5: The Project Manager

`ProjectManager` is the landing screen — a two-column layout with a sidebar on the left containing the app logo, description, and credits, and a main content area on the right listing the user's projects.

One of the more fun parts of building this was the random project name generator. Rather than defaulting to boring names like "Project 1", "Project 2", every new project gets a randomly generated two-word name from a list of prefixes and suffixes:

```javascript
const NAME_PREFIXES = [
  'ugly', 'brisk', 'noodle', 'drift', 'echo', 'fable', 'golden', 'harbor',
  'ivy', 'jade', 'kindle', 'lunar', '67', 'creepy', 'skibidi', 'pixel',
  'quartz', 'ripple', 'solar', 'obnoxious',
]

const NAME_SUFFIXES = [
  'canvas', 'forge', 'garden', 'harbor', 'lab', 'meadow', 'nest', 'orbit',
  'studio', 'toilet', 'field', 'monkee', 'yard', 'sprint', 'beacon',
  'vista', 'pulse', 'dock', 'hub', 'wave',
]

function generateProjectName() {
  const prefix = NAME_PREFIXES[Math.floor(Math.random() * NAME_PREFIXES.length)]
  const suffix = NAME_SUFFIXES[Math.floor(Math.random() * NAME_SUFFIXES.length)]
  return `${prefix} ${suffix}`
}
```

Yes, "skibidi toilet" is a valid project name. You're welcome.

The `handleCreate` function creates the project and immediately navigates into the editor — there's no separate "name your project" step. The user can rename it from the toolbar inside the editor by clicking the project name:

```javascript
const handleCreate = () => {
  const name = generateProjectName()
  const project = createProject(name)
  setProjects(getAllProjects())
  onOpen(project)  // go straight into the editor
}
```

The delete handler uses `e.stopPropagation()` to prevent the card click (which opens the project) from firing when you click the delete button inside the card:

```javascript
const handleDelete = (id, e) => {
  e.stopPropagation()
  if (!confirm('Delete this project? This cannot be undone.')) return
  deleteProject(id)
  setProjects(getAllProjects())
}
```

The layout is a CSS Grid at the `.project-manager` level:

```css
.project-manager {
  height: 100dvh;
  display: grid;
  grid-template-columns: 320px 1fr;
  background: var(--bg);
  overflow: hidden;
}
```

Using `100dvh` instead of `100vh` is important on mobile Safari, where `100vh` infamously includes the URL bar height, causing content to be obscured. `dvh` stands for "dynamic viewport height" and correctly excludes browser chrome.



## Step 6: The Design System (CSS Variables)

Before building any more components, I spent time on the CSS design system in `src/index.css`. Good design tokens save enormous amounts of time later — when you decide to change the border radius or the primary background color, you change one variable and the whole app updates.

The token system is organized into semantic categories:

```css
:root {
  /* Base backgrounds */
  --bg:          #f4f4f5;
  --bg-raised:   #ffffff;
  --bg-sunken:   #e9e9eb;
  --bg-hover:    #e4e4e6;
  --border:      #d1d1d4;
  --border-focus:#8f8f99;

  /* Text */
  --text-primary:   #18181b;
  --text-secondary: #52525c;
  --text-muted:     #a0a0ab;
  --text-inverse:   #fafafa;

  /* Accent */
  --accent:         #27272a;
  --accent-hover:   #18181b;
  --accent-text:    #fafafa;

  /* Structure */
  --radius-sm:  6px;
  --radius-md:  10px;
  --radius-lg:  14px;
  --radius-xl:  18px;
  --radius-pill:999px;

  /* Layout */
  --toolbar-h:    56px;
  --ai-panel-max: 280px;
  --ai-input-h:   40px;
}
```

The dark mode overrides are defined in a `prefers-color-scheme: dark` media query, swapping out every variable:

```css
@media (prefers-color-scheme: dark) {
  :root {
    --bg:          #111113;
    --bg-raised:   #1a1a1d;
    --bg-sunken:   #0c0c0e;
    --bg-hover:    #222226;
    --border:      #2c2c31;
    --border-focus:#48484f;
    --text-primary:   #f0f0f2;
    --text-secondary: #87878f;
    /* ... etc */
  }
}
```

Because every single color in every component references a CSS variable, dark mode is completely free — no conditional classes, no JavaScript, no `ThemeProvider`. The browser handles it entirely through the media query.



## Step 7: The Editor Shell

The `Editor` component is the most architecturally important component in the app. It's responsible for managing all file state, handling the view mode (code/preview/split), and orchestrating the interaction between the code editor and the AI panel.

```javascript
// src/components/Editor.jsx
import { useState, useCallback } from 'react'
import Toolbar from './Toolbar'
import CodeView from './CodeView'
import PreviewPane from './PreviewPane'
import AIPanel from './AIPanel'
import { getFile, saveFile } from '../storage'

const FILES = [
  { key: 'html', label: 'index.html', language: 'html' },
  { key: 'css',  label: 'common.css', language: 'css' },
  { key: 'js',   label: 'scripts.js', language: 'javascript' },
]

export default function Editor({ project, onClose }) {
  const [viewMode, setViewMode] = useState('split')
  const [activeFile, setActiveFile] = useState('html')
  const [files, setFiles] = useState({
    html: getFile(project.id, 'html'),
    css:  getFile(project.id, 'css'),
    js:   getFile(project.id, 'js'),
  })

  const handleFileChange = useCallback((fileKey, content) => {
    setFiles(prev => ({ ...prev, [fileKey]: content }))
    saveFile(project.id, fileKey, content)
  }, [project.id])

  const handleAIUpdate = useCallback((updates) => {
    setFiles(prev => {
      const next = { ...prev, ...updates }
      Object.entries(updates).forEach(([key, content]) => {
        saveFile(project.id, key, content)
      })
      return next
    })
  }, [project.id])

  return (
    <div className={`editor editor--${viewMode}`}>
      <Toolbar
        project={project}
        viewMode={viewMode}
        onViewChange={setViewMode}
        onBack={onClose}
        files={files}
      />
      
      <div className="editor-body">
        {(viewMode === 'code' || viewMode === 'split') && (
          <div className="code-pane">
            <CodeView
              files={FILES}
              activeFile={activeFile}
              onTabChange={setActiveFile}
              content={files[activeFile]}
              language={FILES.find(f => f.key === activeFile).language}
              onChange={(content) => handleFileChange(activeFile, content)}
            />
            <AIPanel
              projectId={project.id}
              files={files}
              onUpdate={handleAIUpdate}
            />
          </div>
        )}
        {(viewMode === 'preview' || viewMode === 'split') && (
          <PreviewPane files={files} />
        )}
      </div>
    </div>
  )
}
```

The layout is driven by a CSS class on the root `div`. The editor has three view modes — `code`, `preview`, and `split` — and the CSS grid changes based on which one is active:

```css
.editor {
  display: grid;
  grid-template-rows: var(--toolbar-h) 1fr;
  height: 100dvh;
  overflow: hidden;
}

.editor-body {
  display: grid;
  overflow: hidden;
  min-height: 0;
}

.editor--code .editor-body    { grid-template-columns: 1fr; }
.editor--preview .editor-body { grid-template-columns: 1fr; }
.editor--split .editor-body   { grid-template-columns: 1fr 1fr; }

.editor--code .preview-pane   { display: none; }
.editor--preview .code-pane   { display: none; }
```

That `min-height: 0` on `.editor-body` is a subtle but critical fix. Grid children by default have a minimum size equal to their content, which means in a grid layout, the Monaco editor will try to expand to its full content height rather than being constrained by the grid cell. Setting `min-height: 0` on the grid item allows it to shrink below its content height, which is what we need for the editor to fill its cell without overflow.

The two key update handlers are both wrapped in `useCallback` with `[project.id]` as the dependency. `handleFileChange` is called by Monaco on every keystroke — it updates React state and immediately persists to localStorage. There's no debounce, which might seem wasteful, but localStorage writes are synchronous and fast (typically sub-millisecond for this amount of data), so the overhead is negligible and the benefit is that you never lose work even if you close the tab mid-sentence. `handleAIUpdate` is called by the AI panel when it finishes generating — it takes a partial update object (e.g., `{ html: '...', css: '...' }`) and applies all changes atomically.



## Step 8: The Code View and Monaco

`CodeView` is a deliberately thin wrapper around the Monaco editor:

```javascript
// src/components/CodeView.jsx
import Editor from '@monaco-editor/react'

export default function CodeView({ files, activeFile, onTabChange, content, language, onChange }) {
  return (
    <div className="code-view">
      <div className="tab-bar">
        {files.map(f => (
          <button
            key={f.key}
            className={`tab ${activeFile === f.key ? 'tab--active' : ''}`}
            onClick={() => onTabChange(f.key)
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="editor-container">
        <Editor
          height="100%"
          language={language}
          value={content}
          onChange={onChange}
          theme="vs-dark"
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  )
}
```

A few decisions worth explaining here. I disabled the minimap (`minimap: { enabled: false }`) because it's noise at the file sizes we're working with — the minimap is useful for navigating thousand-line files, not 50-line HTML. `wordWrap: 'on'` is essential since HTML templates often have long lines. `scrollBeyondLastLine: false` keeps the editor clean — by default Monaco adds padding below the last line of code, which can feel odd when the editor fills a grid cell. Most importantly, `automaticLayout: true` tells Monaco to automatically resize itself when its container changes dimensions. This is critical for the split view — when the user resizes their browser window, the grid recalculates, Monaco needs to respond, and without `automaticLayout: true` the editor would stay frozen at its initial size.

The `value={content}` / `onChange={onChange}` pattern is controlled-component style. The parent (`Editor`) owns the state; `CodeView` is just a display component. When the user types, `onChange` fires, which calls `handleFileChange` in `Editor`, which updates `files` state, which flows back down as `content` to `CodeView`. React reconciles this fast enough that the Monaco editor feels instant.



## Step 9: The Preview Pane

The preview pane renders the user's code in a live `<iframe>`. The naive approach — point the iframe `src` at some URL — doesn't work because the HTML, CSS, and JS files don't exist as actual files on a server. They exist as strings in React state. The solution is to use `srcDoc`, which is an iframe attribute that accepts raw HTML as a string and uses it as the document content.

But there's a problem: the HTML in localStorage references `common.css` via `<link rel="stylesheet" href="common.css">` and `scripts.js` via `<script src="scripts.js">`. Inside an `srcDoc` iframe, these relative paths resolve against `about:blank` (or the parent page's origin), not any real filesystem, so they 404 silently and nothing loads.

The fix is to inline the CSS and JS directly into the HTML before passing it to `srcDoc`:

```javascript
// src/components/PreviewPane.jsx
import { useMemo } from 'react'

function buildDocument(files) {
  let html = files.html

  // Replace <link rel="stylesheet" href="common.css"> with inline <style>
  html = html.replace(
    /<link[^>]+href=["']common\.css["'][^>]*\/?>/gi,
    `<style>\n${files.css}\n</style>`
  )

  // Replace <script src="scripts.js"></script> with inline <script>
  html = html.replace(
    /<script[^>]+src=["']scripts\.js["'][^>]*><\/script>/gi,
    `<script>\n${files.js}\n</script>`
  )

  return html
}

export default function PreviewPane({ files }) {
  const srcDoc = useMemo(() => buildDocument(files), [files])

  return (
    <div className="preview-pane">
      <div className="preview-toolbar">
        <span>Preview</span>
      </div>
      <iframe
        className="preview-frame"
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
        title="Site Preview"
      />
    </div>
  )
}
```

The `useMemo` here is important for performance. `buildDocument` runs two regex replacements on potentially large strings. Without memoization, it would re-run on every render of `PreviewPane`. With `useMemo([files])`, it only re-runs when the `files` object reference changes, which happens exactly when the user edits code or the AI updates files.

The `sandbox` attribute on the iframe deserves some explanation. `allow-scripts` lets user JavaScript run, which is obviously necessary. `allow-same-origin` allows the iframe content to be treated as same-origin with the parent — this is needed so the preview can run scripts that access `window`, `document`, etc., normally. `allow-forms` lets form submissions work in the preview. `allow-modals` allows `alert()`, `confirm()`, and `prompt()` to work, which is useful when testing interactive pages. We deliberately omit `allow-popups` and `allow-top-navigation` for security — the preview shouldn't be able to navigate the parent page.



## Step 10: The OpenRouter Streaming Layer

The AI integration is powered by streaming completions via the OpenRouter API. OpenRouter is a unified API gateway that routes requests to Claude, GPT-4, Gemini, Llama, and essentially any other LLM you'd want to use — all through a single API with a consistent interface. The user configures their API key in settings, and by default we route to `https://openrouter.ai/api/v1/chat/completions`.

The core of the streaming logic lives in `src/lib/openrouter.js`:

```javascript
// src/lib/openrouter.js
export async function streamCompletion({
  apiKey, endpoint, model, messages,
  onChunk, onThinking, onDone, onError
}) {
  const url = endpoint || 'https://openrouter.ai/api/v1/chat/completions'
  
  const body = {
    model,
    messages,
    stream: true,
  }

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': window.location.origin,
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    onError(`Network error: ${err.message}`)
    return
  }

  if (!response.ok) {
    const errText = await response.text()
    onError(`API error ${response.status}: ${errText}`)
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') { onDone(); return }

      try {
        const parsed = JSON.parse(data)
        const delta = parsed.choices?.[0]?.delta

        if (delta?.content) {
          onChunk(delta.content)
        }

        // Extended thinking support (Claude 3.7+ via OpenRouter)
        if (delta?.thinking) {
          onThinking(delta.thinking)
        }

        // Some models send thinking as content_block_delta
        if (parsed.type === 'content_block_delta') {
          if (parsed.delta?.type === 'thinking_delta') {
            onThinking(parsed.delta.thinking)
          }
          if (parsed.delta?.type === 'text_delta') {
            onChunk(parsed.delta.text)
          }
        }
      } catch { /* skip malformed lines */ }
    }
  }

  onDone()
}
```

This is a manual implementation of Server-Sent Events (SSE) parsing. The OpenAI-compatible streaming format sends responses as `data: {...}\n\n` lines, with a final `data: [DONE]\n\n` to signal completion. We read from the response body stream using the Streams API, decode each chunk, and accumulate into a `buffer` string. We split the buffer on newlines and process each complete line, keeping any incomplete line in the buffer for the next iteration — this handles the case where a TCP packet boundary falls in the middle of a JSON object.

The `HTTP-Referer` header is required by OpenRouter for API calls from browsers — it helps them track which apps are using their service and is part of their terms of service.

The function also handles extended thinking content from Claude's reasoning models. When using `claude-3-7-sonnet:thinking` or similar, the model sends reasoning tokens before the actual response. These arrive in `delta.thinking` (OpenRouter's format) or as `content_block_delta` events with `type: "thinking_delta"` (Anthropic's native streaming format). We expose these through a separate `onThinking` callback so the UI can display them in a collapsible section.



## Step 11: The AI Panel

The `AIPanel` component is where the magic happens from a user perspective. It lives at the bottom of the code pane and accepts natural language descriptions of changes the user wants, sends them to the LLM with the current file contents as context, streams the response, and applies the updates when done.

The system prompt is the most important part of making this work reliably:

```javascript
const SYSTEM_PROMPT = `You are an expert web developer. The user will describe changes they want
to make to their website. You have access to three files: index.html, common.css, and scripts.js.

Always respond with the COMPLETE updated file contents (not diffs) wrapped in XML tags like this:

<html>
<!DOCTYPE html>
...full file...
</html>

<css>
/* full file */
</css>

<js>
// full file
</js>

Only include files you are changing. If a file doesn't need changes, omit its tags entirely.
Do not explain what you did. Only output the XML-tagged file contents.`
```

The decision to request complete file contents rather than diffs is deliberate and important. Diffs are hard to parse reliably, especially when the LLM might format them inconsistently across different models. Complete files are trivially parseable with a simple regex, and the "only include files you're changing" instruction keeps token usage down — if the user just asks to change the heading color, the model only needs to return the updated CSS, not all three files. This also means the prompt is self-healing in a sense: even if the model changes something slightly unexpected, you always get a complete, coherent file rather than a partial diff that might fail to apply.

The user message construction attaches the current file state:

```javascript
function buildUserMessage(prompt, files) {
  return `Current files:

<html>
${files.html}
</html>

<css>
${files.css}
</css>

<js>
${files.js}
</js>

User request: ${prompt}`
}
```

And the response parser extracts whatever file tags are present:

```javascript
function parseAIResponse(text) {
  const updates = {}
  const htmlMatch = text.match(/<html>([\s\S]*?)<\/html>/)
  const cssMatch  = text.match(/<css>([\s\S]*?)<\/css>/)
  const jsMatch   = text.match(/<js>([\s\S]*?)<\/js>/)
  if (htmlMatch) updates.html = htmlMatch[1].trim()
  if (cssMatch)  updates.css  = cssMatch[1].trim()
  if (jsMatch)   updates.js   = jsMatch[1].trim()
  return updates
}
```

The component manages several pieces of state: the prompt text, a status enum (`'idle' | 'thinking' | 'generating' | 'error'`), accumulated thinking text, accumulated response text, and a toast notification array.

One detail worth highlighting is the textarea auto-resize logic:

```javascript
const syncPromptHeight = (value) => {
  const el = textareaRef.current
  if (!el) return

  el.style.height = `${MIN_PROMPT_HEIGHT}px`
  const nextHeight = Math.min(el.scrollHeight, MAX_PROMPT_HEIGHT)
  el.style.height = `${Math.max(nextHeight, MIN_PROMPT_HEIGHT)}px`
  setIsPromptExpanded(el.scrollHeight > MIN_PROMPT_HEIGHT + 2 || value.includes('\n'))
}
```

The trick here is to first set `height` back to the minimum before reading `scrollHeight`. If you read `scrollHeight` while the element is already expanded, it returns the current height rather than the content height, so you can never shrink it. By collapsing it first, you force the browser to recalculate, then expand to the actual content height capped at `MAX_PROMPT_HEIGHT`. The `isPromptExpanded` state is used to add a CSS class that adjusts the padding of the panel container — when the textarea grows, we add a little extra padding to keep things from feeling cramped.

The thinking block is displayed in a `<details>` element, which gives us the collapse/expand behavior for free without any state:

```jsx
{showThinking && thinkingText && (
  <details className="thinking-block">
    <summary>Thinking...</summary>
    <pre>{thinkingText}</pre>
  </details>
)}
```

## Step 12: Toast Notifications

Rather than importing a toast library (which adds bundle size and style conflicts), I built a minimal toast system from scratch. It's two components — `Toast` and `ToastContainer` — and fits in about 40 lines.

```javascript
// src/components/Toast.jsx
import { useEffect } from 'react'
import { FiAlertCircle, FiX } from 'react-icons/fi'

export function Toast({ message, type = 'error', onClose, autoClose = 5000 }) {
  useEffect(() => {
    if (!autoClose) return
    const timer = setTimeout(onClose, autoClose)
    return () => clearTimeout(timer)
  }, [autoClose, onClose])

  return (
    <div className={`toast toast-${type}`}>
      <div className="toast-content">
        <FiAlertCircle className="toast-icon" size={18} />
        <p className="toast-message">{message}</p>
      </div>
      <button className="toast-close" onClick={onClose} aria-label="Close notification">
        <FiX size={16} />
      </button>
    </div>
  )
}

export function ToastContainer({ toasts, onRemove }) {
  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          onClose={() => onRemove(toast.id)}
          autoClose={toast.autoClose}
        />
      ))}
    </div>
  )
}
```

In `AIPanel`, the toast state is managed as an array with monotonically increasing IDs:

```javascript
const [toasts, setToasts] = useState([])
const toastIdRef = useRef(0)

const addToast = (message, type = 'error', autoClose = 5000) => {
  const id = ++toastIdRef.current
  setToasts(prev => [...prev, { id, message, type, autoClose }])
  return id
}

const removeToast = (id) => {
  setToasts(prev => prev.filter(t => t.id !== id))
}
```

The `toastIdRef` uses a `useRef` rather than a second piece of state because the ID counter is not display state — incrementing it shouldn't trigger a re-render, and it needs to be mutable. Using a ref for this is the idiomatic React pattern.

## Step 13: The Toolbar

The toolbar handles project naming, view mode switching, download, GitHub export, and settings. It's the most feature-dense component in the app.

The inline rename functionality works by toggling between a display span and an input field:

```javascript
const handleRename = () => {
  const trimmed = name.trim()
  if (!trimmed) { setName(project.name); setEditing(false); return }
  updateProjectMeta(project.id, { name: trimmed })
  project.name = trimmed  // mutate local ref so download uses new name
  setEditing(false)
}
```

That `project.name = trimmed` line is a deliberate mutation of the prop object, which is normally bad practice in React. The justification is that `project` is passed down from `App`'s `activeProject` state, and we'd need to thread a callback all the way up to update it properly. Since the only place the project name is read from the prop (as opposed to from `name` state) is the download function, this shallow mutation keeps things simple without any real downside.

The view toggle is rendered as a segmented control:

```jsx
<div className="view-toggle">
  {[
    { key: 'code',    label: 'Code' },
    { key: 'split',   label: 'Split' },
    { key: 'preview', label: 'Preview' },
  ].map(v => (
    <button
      key={v.key}
      className={`view-btn ${viewMode === v.key ? 'view-btn--active' : ''}`}
      onClick={() => onViewChange(v.key)}
    >
      {v.label}
    </button>
  ))}
</div>
```

The active button gets a raised appearance via `box-shadow: var(--shadow-sm)` and a white (or dark-mode equivalent) background, while inactive buttons are transparent — the standard pill segmented control pattern.

## Step 14: The Download Feature

The download feature uses `fflate`, a pure-JavaScript zip library, to bundle the three project files into a `.zip` archive and trigger a browser download:

```javascript
// src/lib/download.js
import * as fflate from 'fflate'

export function downloadProject(projectName, files) {
  const encoder = new TextEncoder()

  const zipData = {
    'index.html': encoder.encode(files.html),
    'common.css': encoder.encode(files.css),
    'scripts.js': encoder.encode(files.js),
  }

  fflate.zip(zipData, (err, zipped) => {
    if (err) { console.error(err); return }
    
    const blob = new Blob([zipped], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${projectName.replace(/\s+/g, '-').toLowerCase()}.zip`
    a.click()
    URL.revokeObjectURL(url)
  })
}
```

The `TextEncoder` converts string file contents to `Uint8Array`, which is what `fflate` expects. After zipping, we create a `Blob` with the appropriate MIME type, generate an object URL, create a temporary anchor element, set its `download` attribute (which triggers a download rather than navigation), programmatically click it, and then immediately revoke the object URL to free memory. The project name is sanitized with `.replace(/\s+/g, '-').toLowerCase()` so it's a valid filename.

## Step 15: The GitHub Export

The GitHub export is the most complex feature in the app. It uses the GitHub REST API to create or update a repository with the current project files, using the Git Data API to create blobs, trees, and commits manually — the low-level plumbing that underlies every git operation.

```javascript
// src/lib/github.js
async function ghFetch(token, path, method = 'GET', body = null) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.message || `GitHub error ${res.status}`)
  }
  return res.status === 204 ? null : res.json()
}
```

The `ghFetch` helper handles the boilerplate for every GitHub API call. The `204 No Content` check is necessary because some API endpoints (like force-updating a ref) return 204 with no body, and calling `res.json()` on an empty response throws a parse error.

The full export flow has six steps — get username, create or get repo, get latest commit SHA, create blobs, create tree, create commit, update branch reference:

```javascript
export async function exportToGitHub({ token, repoName, projectName, files }) {
  const username = (await ghFetch(token, '/user')).login

  let repo
  try {
    repo = await ghFetch(token, `/repos/${username}/${repoName}`)
  } catch {
    repo = await ghFetch(token, '/user/repos', 'POST', {
      name: repoName,
      description: `Built with AI Site Builder — ${projectName}`,
      auto_init: true,
      private: false,
    })
    await new Promise(r => setTimeout(r, 1500))
  }

  const ref = await ghFetch(token, `/repos/${username}/${repoName}/git/ref/heads/main`)
  const latestCommitSha = ref.object.sha
  const baseTree = (await ghFetch(token, `/repos/${username}/${repoName}/git/commits/${latestCommitSha}`)).tree.sha

  const encoder = content => btoa(unescape(encodeURIComponent(content)))
  
  const blobs = await Promise.all([
    ghFetch(token, `/repos/${username}/${repoName}/git/blobs`, 'POST', { content: encoder(files.html), encoding: 'base64' }),
    ghFetch(token, `/repos/${username}/${repoName}/git/blobs`, 'POST', { content: encoder(files.css),  encoding: 'base64' }),
    ghFetch(token, `/repos/${username}/${repoName}/git/blobs`, 'POST', { content: encoder(files.js),   encoding: 'base64' }),
  ])

  const tree = await ghFetch(token, `/repos/${username}/${repoName}/git/trees`, 'POST', {
    base_tree: baseTree,
    tree: [
      { path: 'index.html', mode: '100644', type: 'blob', sha: blobs[0].sha },
      { path: 'common.css', mode: '100644', type: 'blob', sha: blobs[1].sha },
      { path: 'scripts.js', mode: '100644', type: 'blob', sha: blobs[2].sha },
    ],
  })

  const commit = await ghFetch(token, `/repos/${username}/${repoName}/git/commits`, 'POST', {
    message: `Update via AI Site Builder`,
    tree: tree.sha,
    parents: [latestCommitSha],
  })

  await ghFetch(token, `/repos/${username}/${repoName}/git/refs/heads/main`, 'PATCH', {
    sha: commit.sha,
  })

  return `https://github.com/${username}/${repoName}`
}
```

The `await new Promise(r => setTimeout(r, 1500))` after creating a new repo is a hack, but a necessary one. GitHub's API returns a `201 Created` for the new repo before the initial commit (triggered by `auto_init: true`) is fully written. If you immediately try to get the `refs/heads/main` reference, you'll get a 409 or 404 because the commit hasn't been created yet. The 1.5 second delay gives GitHub's infrastructure time to finish initializing. A more robust solution would be to poll the refs endpoint until it returns a 200, but for a tool this simple, a fixed delay is fine.

The `encoder = content => btoa(unescape(encodeURIComponent(content)))` is the standard trick for base64-encoding UTF-8 strings in a browser. `btoa` only accepts Latin-1 characters, so we first percent-encode the string with `encodeURIComponent` (which handles any Unicode), then decode the percent-encoding back to bytes with `unescape`, and finally base64-encode the resulting byte string.

The three blob creations are run in parallel with `Promise.all`, which cuts the API call time roughly in thirds.

## Step 16: The Settings and GitHub Modals

Both modals follow the same pattern: an overlay div that closes the modal on click, a centered modal panel that stops click propagation (so clicking inside the modal doesn't close it), and a footer with Cancel and a primary action button.

```jsx
<div className="modal-overlay" onClick={onClose}>
  <div className="modal" onClick={e => e.stopPropagation()}>
    {/* content */}
  </div>
</div>
```

The Settings modal lets users configure three things: API key, API endpoint, and model. The model field uses a `<datalist>` to provide autocomplete suggestions without restricting input — the user can type any arbitrary model string:

```jsx
<input
  value={form.model}
  onChange={e => setForm(p => ({ ...p, model: e.target.value }))}
  placeholder="Choose or type a model"
  list="popular-models"
/>
<datalist id="popular-models">
  {POPULAR_MODELS.map(m => <option key={m} value={m} />)}
</datalist>
```

This is one of those underused HTML features that's genuinely great. `<datalist>` gives you browser-native autocomplete with a custom options list, works in every modern browser, and requires zero JavaScript or external library.

## Step 17: Responsive Design

The app has three breakpoints. At 1024px we reduce padding and ensure the split view grid columns can shrink. At 860px the toolbar switches to a two-row layout (name+actions on top, view toggle below) using CSS Grid areas:

```css
@media (max-width: 860px) {
  .toolbar {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'left right'
      'center center';
    height: auto;
    padding: 0.55rem 0.7rem;
  }
  
  .editor--split .editor-body {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  }
  
  .editor--split .code-pane {
    border-right: none;
    border-bottom: 1.5px solid var(--border);
  }
}
```

On narrow screens, the split view switches from horizontal to vertical — the code pane stacks above the preview pane. The border between them also switches from right to bottom to match the new direction. At 600px we additionally increase the AI panel max height (since vertical space is less precious than horizontal on a phone) and make the view toggle buttons fill the available width with `flex: 1`.

## Putting It All Together

If you want to build this yourself from scratch, here's the sequence: scaffold with Vite, install the dependencies, write `storage.js` and `SettingsContext.jsx` first since everything else depends on them, then build the `ProjectManager`, then the `Editor` shell with its grid layout, then `CodeView` with Monaco, then `PreviewPane` with the srcDoc injection, then `openrouter.js` and `AIPanel`, then `Toolbar` with download and GitHub, then polish with the modal components and toasts. Test at each step — the Monaco editor, the streaming, and the GitHub export are the three places where things are most likely to go wrong.

The total bundle is surprisingly small for what it does. Monaco is the heavy piece (it's a full code editor engine, after all), but `@monaco-editor/react` loads it lazily and only when the editor actually mounts. Everything else — the storage layer, the streaming parser, the GitHub integration, the zip utility — is lightweight. The whole app, excluding Monaco, is probably under 50KB of application code.

The thing I'm most satisfied with is that it actually works offline. After the initial load (which fetches Monaco and the fonts), the entire app functions with no network connection. You can create projects, edit code, see the preview, and manage your work without touching the internet. The AI panel gracefully fails with a toast notification if there's no network, and the download and all project management functions work entirely locally.

The GitHub export and AI panel are the only features that require network access, and both of them make it extremely clear to the user what's happening and where their data is going. For an app that stores API keys locally and positions itself as privacy-conscious, that transparency matters.



## What I'd Do Differently

If I were starting over, I'd strongly consider a more structured storage format — maybe IndexedDB via `idb` — for larger files. `localStorage` has a 5-10MB limit per origin (browser-dependent), which is plenty for the small HTML/CSS/JS files this app targets, but it's a ceiling that could become a problem. I'd also add some form of file history or undo beyond Monaco's built-in undo stack — right now if the AI completely borks your file and you've made changes since, recovering the original requires remembering what you had. And I'd probably add a way to import an existing project from a ZIP, which is the natural counterpart to the export feature.

## Links and stuff

Here's the working demo of MyDE: [myde.emjjkk.tech](https://myde.emjjkk.tech).
The source code is open-source on [Github](https://github.com/emjjkk/myde), too

