# ChatGPT Auto Poster

> Browser extension: auto-generate DALL-E images from PDF placeholders, with AI review.

## What it does

1. You write a PDF with `[illustration: description]` markers where images should go
2. The extension parses the PDF, extracts all markers
3. It sends each prompt to ChatGPT (DALL-E) in your browser, one by one
4. **(Optional)** A second ChatGPT tab reviews each generated image with GPT-4V, scores it out of 100, and requests revisions if the score is below your threshold
5. All images are automatically downloaded

## Project structure

```
ChatGPT-Haibao/
├── extension/               # Chrome/Edge extension (load this)
│   ├── manifest.json
│   ├── popup.html           # Extension popup UI
│   ├── popup.js             # PDF parsing + project management
│   ├── background.js        # Task queue + dual-tab orchestration
│   ├── content.js           # ChatGPT page automation + anti-detection
│   └── lib/
│       ├── pdf.min.mjs      # PDF.js
│       └── pdf.worker.min.mjs
├── projects/                # Your projects go here
│   ├── project1/            # Example: Course posters
│   │   ├── README.md        # Project notes
│   │   └── materials/       # Reference images, style guides
│   └── project2/            # Example: Product images
│       ├── README.md
│       └── materials/
├── .gitignore
└── README.md
```

## Quick start

### 1. Load the extension

**Chrome:** `chrome://extensions` → Developer mode → Load unpacked → select `extension/` folder

**Edge:** `edge://extensions` → Developer mode → Load unpacked → select `extension/` folder

### 2. Prepare your PDF

Add markers in this format anywhere in your PDF:

```
[illustration: A futuristic city skyline at sunset, blue-gold palette, vertical composition]
```

### 3. Run

1. Open `chatgpt.com` and log in
2. Click the extension icon
3. Create a project (or use "Default")
4. Fill in your style prompt (e.g. "Professional poster style, blue-gold color scheme")
5. Select your PDF → click **Parse**
6. Configure review settings (optional):
   - **Enable review**: GPT-4V scores each image
   - **Pass threshold**: score must be >= this to pass (default 80/100)
   - **Max retries**: how many times to revise if rejected
7. Click **Start Auto Generate**

### 4. Get your images

Images download to `chatgpt-posters/` in your default download folder. Each image is named `P{page}_{index}_{description}.png`.

## Features

### Multi-project support
Switch between projects in the popup. Each project saves its own:
- Style prompt
- Review settings
- Custom review criteria

### AI Review (optional)
- Enable review to have GPT-4V score each generated image
- Set your pass threshold (default 80/100)
- Failed images get auto-revised with specific feedback
- Configurable max retries

### Anti-detection
- Human-like typing (character-by-character with randomized delays)
- Random typos with backspace correction (~3% chance per character)
- Mouse hover/move/click simulation with random positions
- All timing uses jitter (30-50% variance)
- Random thinking pauses
- Page scrolling during waits

### Resilience
- Queue persists to storage (survives browser/worker restarts)
- Auto-resume on startup
- Communication retries (3x per message)
- Tab lifecycle management

## PDF marker format

| Format | Example |
|--------|---------|
| `[illustration: description]` | `[illustration: A modern office interior, bright lighting, wide angle]` |

**Note:** If your PDF uses Chinese brackets `【】`, the parser supports both `[illustration: xxx]` (English) format. For Chinese brackets, write `【illustration：xxx】` in your PDF.

## Requirements

- Chrome or Edge (Chromium-based)
- ChatGPT Plus/Pro account (for DALL-E access)
- For review: GPT-4V access

## Project presets

The extension stores project settings in browser local storage. To back up or share project configs, export your settings from `chrome.storage.local` or use the project notes in `projects/`.

---

Made for automating DALL-E poster/image generation workflows.
