# INF-1.0 Premium

A polished Flask-based AI workspace with:
- guest mode that works immediately
- local signup/login and optional Firebase Google login
- saved chats for signed-in users
- premium glassmorphism UI with animations
- settings for themes, personalization, response style, and default model
- image upload with automatic vision handling
- background web search support
- INF-1.0 auto routing and all-model synthesis mode

## Required environment variables

```bash
SECRET_KEY=change-me
GROQ_API_KEY=your_groq_api_key
PORT=8080
```

Optional for Google login:

```bash
FIREBASE_CREDENTIALS={...json service account...}
```

## Local run

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

## Notes

- Guest users can chat immediately.
- Signing in is only needed for saved chat history and synced settings.
- Add your Firebase web config inside `static/app.js` by setting `window.firebaseConfig` if you want Google sign-in.
