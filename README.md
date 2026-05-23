# DSGolf

## Online multiplayer

DSGolf uses a small Node relay server for lobby codes, phone controllers, and host state. For friends on cellular or different Wi-Fi networks, run the app from a public HTTPS host so every device can reach the same server.

Local run:

```sh
npm install
npm run network
```

Then open `http://localhost:3000` on the host screen. Localhost is only for local testing; friends on cellular need a deployed HTTPS URL.

Public deployment:

```sh
npm run build
npm start
```

Set `PUBLIC_BASE_URL` to the public HTTPS origin, for example:

```sh
PUBLIC_BASE_URL=https://your-dsgolf-app.example.com
```

Most platforms also provide `PORT`; `server.mjs` uses it automatically. Once deployed, the host opens the public URL, starts an online game, and friends open the shown join link or enter the host code from their phones.

iPhone motion controls require HTTPS. A normal public deployment satisfies this. For same-Wi-Fi local testing only, run:

```sh
HTTPS=1 npm run network
```
