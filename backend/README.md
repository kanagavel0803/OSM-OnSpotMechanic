# OSM Backend (MySQL)
Run:
1) Create DB and tables: import `schema.sql`
2) Copy `.env.example` to `.env` and fill values
3) `npm install`
4) `npm run dev`

The API matches the original endpoints used by the frontend:
- POST   /register
- POST   /login
- POST   /service-request
- PUT    /service-request/approve/:id   (JWT: Mechanic)
- PUT    /service-request/reject/:id    (JWT: Mechanic)
- GET    /service-requests/user/:userId (Public)  — kept for compatibility
- GET    /service-requests/user         (JWT: Customer)
- GET    /mechanic/details              (JWT: Mechanic)
- GET    /mechanic/status               (JWT: Mechanic)
- PUT    /mechanic/update-status        (JWT: Mechanic)
- GET    /user-info                     (JWT)
- PUT    /user/update/:id               (JWT: Customer)
- PUT    /mechanic/update/:id           (JWT: Mechanic)
- DELETE /delete-profile/:id            (JWT: Owner)
- POST   /forgot-password               (issue reset token; prints to server logs)
- POST   /reset-password                (reset via token)
