# Attendly React + Express

Clean production package for Railway.

## Railway setup
1. Push these files to GitHub using GitKraken.
2. Deploy the repo on Railway.
3. Add a PostgreSQL database to the same Railway project.
4. Add variables to the app service:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET=make-this-a-long-random-secret
ADMIN_EMAIL=admin@attendly.local
ADMIN_PASSWORD=admin123!
NODE_ENV=production
```

5. Redeploy.

Default login:

```
admin@attendly.local
admin123!
```

If login ever breaks, POST to `/api/reset-admin` with JSON `{ "key": "YOUR_JWT_SECRET" }`, or create a new empty PostgreSQL database and redeploy.

## Features
- React admin portal
- Express API
- PostgreSQL storage
- Admin login
- Employees CRUD
- PIN kiosk clock in/out
- Manual punches
- PTO requests and approvals
- PTO balances
- Payroll reports
- CSV exports
- Mobile-friendly layout
