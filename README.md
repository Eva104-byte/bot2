# Deriv Over/Under Dual Bot v3 — Railway Deployment

## 🚀 Deploy to Railway in 3 steps

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Deriv Dual Bot — 4.5x Martingale"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 2. Deploy on Railway
1. Go to [railway.app](https://railway.app) and sign in
2. Click **New Project → Deploy from GitHub repo**
3. Select your repository
4. Railway auto-detects Node.js and deploys — done!

### 3. Access your bot
Railway gives you a public URL like `https://your-app.up.railway.app`.
Open it in any browser to access the full bot dashboard 24/7.

## ⚙️ Configuration
- **Port**: Railway auto-assigns via `$PORT` env variable
- **Restart policy**: Restarts on failure (up to 10 retries)
- **Node**: Requires Node 18+

## 📋 Bot Settings
- Martingale multiplier: **4.5×** on loss (one step only)
- Over 1 bot: watches digits 0, 1, 2
- Under 8 bot: watches digits 7, 8, 9
- Paste your Deriv API token in the UI after opening the URL

## ⚠️ Important
Always test with a **demo account token** first.
