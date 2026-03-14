# INF-1.0 upgrade

This is a fuller rewrite of the original Infinity AI Flask prototype.

## Included changes

- fixed broken Flask routes for chat loading and deletion
- rebuilt the app into a maintainable Flask structure
- added local email/password auth
- kept guest login for quick access
- kept Firebase token verification support for Google login
- added SQLite persistence for users, settings, chats, and messages
- added working DuckDuckGo web search
- added visible source cards in the UI for search results
- added INF-1.0 auto routing across specialist models
- added INF-1.0 all-model synthesis mode
- made image uploads trigger the vision flow by default
- added personalization settings, response style, theme, default model, and web search mode
- rebuilt the UI to feel closer to modern AI chat products

## Required environment variables

```bash
SECRET_KEY=change-me
GROQ_API_KEY=your_groq_api_key
FIREBASE_CREDENTIALS={...json service account...}
PORT=8080
```

`FIREBASE_CREDENTIALS` is optional unless you want Firebase-backed Google login.

## Local run

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

## Firebase login note

To enable browser-side Google sign-in, add your Firebase web config to `static/app.js`.
The backend already supports Firebase ID token verification if `FIREBASE_CREDENTIALS` is configured.

## Default modes

- `INF-1.0`: automatically routes the request to the best internal specialist
- `INF-1.0 All-model synthesis`: runs multiple specialists and merges them into one answer
- image attached: vision path is used automatically

## Important limitation

This package gives you a strong working base, but you still need to plug in your own production secrets,
Firebase config, and deployment settings before pushing live.
