# Attendly Base44-Style Railway App

A cleaner Base44-style rebuild of Attendly with a mobile kiosk, admin dashboard, employee management, punches, PTO, balances, reports, PostgreSQL storage, and a simple Node/Express server.

## Railway

Required variables:

```
DATABASE_URL=<Railway PostgreSQL URL>
ADMIN_EMAIL=admin@attendly.local
ADMIN_PASSWORD=admin123!
NODE_ENV=production
```

Railway should detect the Dockerfile and run the app. If it asks for a port, use `4000` or leave it to Railway's `PORT` variable.

## Login

```
admin@attendly.local
admin123!
```
