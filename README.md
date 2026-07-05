# Attendly Final

Railway-ready Attendly replacement.

## Railway variables

Required:
- DATABASE_URL = your Railway PostgreSQL connection string
- JWT_SECRET = any long random text
- NODE_ENV = production

Optional:
- ADMIN_EMAIL = admin@attendly.local
- ADMIN_PASSWORD = admin123!

## Login
- admin@attendly.local
- admin123!

This version is schema-safe: it creates missing tables and adds missing columns if an older database schema already exists.
