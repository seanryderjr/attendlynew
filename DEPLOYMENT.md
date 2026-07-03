# Attendly shared multi-computer deployment

This production package is designed so every employee kiosk and every admin computer talks to the same hosted API and PostgreSQL database.

```text
Employee kiosk browser → Attendly web/API server → PostgreSQL database ← Admin browser
```

## Easiest production path: Render

1. Create a new GitHub repository.
2. Upload this entire `attendly-production` folder.
3. In Render, choose **New + → Blueprint**.
4. Connect the GitHub repo.
5. Render will read `render.yaml`, create the web service and PostgreSQL database, then deploy.
6. Open the Render app URL in every browser that needs access.

Default seeded admin login:

```text
admin@attendly.local
admin123!
```

Change that password immediately after first login in a real deployment. This demo seed keeps the login simple; production should add a password-change screen or update the seeded password directly.

## Local office-server path

Use this if you want one computer/server in the office to host the app for all devices on the same Wi-Fi/LAN.

```bash
cp .env.example .env
docker compose up -d
npm install
npm run db:generate
npm run db:migrate
npm run db:seed
npm run build
NODE_ENV=production npm start
```

Then other computers can open:

```text
http://OFFICE_SERVER_IP:4000
```

Example:

```text
http://192.168.1.50:4000
```

Make sure the server firewall allows inbound TCP traffic on port `4000`.

## Environment variables

Required:

```text
DATABASE_URL=postgresql://...
JWT_SECRET=long-random-secret
NODE_ENV=production
```

Optional:

```text
CLIENT_ORIGIN=https://your-app-domain.com
PORT=4000
```

## How data sharing works

All punch, PTO, balance, employee, and report data is stored in PostgreSQL, not the browser. Any browser that opens the same deployed app URL will read and write to the same database.

## Notes before real payroll use

Before using this for payroll, add: password reset, HTTPS-only deployment, stricter role permissions, backups, audit review, employee edit history, timezone policy, and legal/payroll compliance review for your state/country.
