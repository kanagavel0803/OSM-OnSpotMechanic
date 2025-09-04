import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import validator from "validator";
import mysql from "mysql2/promise";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "MYKEY";

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// MySQL pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "osm_app",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

const ok = (res, data) => res.json({ success: true, ...data });
const bad = (res, message, code = 400) => res.status(code).json({ success: false, message });

// JWT middleware
const jwtMiddleware = (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return bad(res, "Access Denied. No token provided.", 401);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, userType }
    next();
  } catch (e) {
    return bad(res, "Invalid token", 400);
  }
};

// Helpers
const hash = (pwd) => bcrypt.hash(pwd, 10);
const compare = (pwd, hash) => bcrypt.compare(pwd, hash);

// ---- Routes ----
app.get("/", (_, res) => res.send("OSM MySQL API running"));

// Register
app.post("/register", async (req, res) => {
  try {
    const { Name, username, mobile, email, password, userType, latitude, longitude } = req.body;
    if (!Name || !username || !mobile || !email || !password || !userType) {
      return bad(res, "Missing required fields.");
    }
    if (!validator.isEmail(email)) return bad(res, "Invalid email");

    const conn = await pool.getConnection();
    try {
      const [dupUser] = await conn.query(
        "SELECT id FROM users WHERE username=? OR email=? UNION SELECT id FROM mechanics WHERE username=? OR email=?",
        [username, email, username, email]
      );
      if (dupUser.length) return bad(res, "Username or email already exists", 409);

      const pwdHash = await hash(password);

      if (userType === "Mechanic") {
        if (typeof latitude !== "number" || typeof longitude !== "number") {
          return bad(res, "Mechanic must provide latitude and longitude");
        }
        await conn.query(
          `INSERT INTO mechanics (name, username, mobile, email, password_hash, latitude, longitude) VALUES (?,?,?,?,?,?,?)`,
          [Name, username, mobile, email, pwdHash, latitude, longitude]
        );
      } else {
        await conn.query(
          `INSERT INTO users (name, username, mobile, email, password_hash) VALUES (?,?,?,?,?)`,
          [Name, username, mobile, email, pwdHash]
        );
      }
      ok(res, { message: "Registered successfully" });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error(e);
    bad(res, "Server error", 500);
  }
});

// Login (checks both users and mechanics)
app.post("/login", async (req, res) => {
  try {
    const { username, password, userType } = req.body;
    if (!username || !password || !userType) return bad(res, "Missing credentials");

    const conn = await pool.getConnection();
    try {
      const table = userType === "Mechanic" ? "mechanics" : "users";
      const [rows] = await conn.query(`SELECT * FROM ${table} WHERE username=?`, [username]);
      if (!rows.length) return bad(res, "Invalid username or password", 401);
      const u = rows[0];
      const passOK = await compare(password, u.password_hash);
      if (!passOK) return bad(res, "Invalid username or password", 401);
      const token = jwt.sign({ id: u.id, userType }, JWT_SECRET, { expiresIn: "7d" });
      ok(res, { message: "Login successful", token });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error(e);
    bad(res, "Server error", 500);
  }
});

// Create service request
app.post("/service-request", async (req, res) => {
  try {
    const { customerName, phoneNumber, serviceType, location, userId } = req.body;
    if (!customerName || !phoneNumber || !serviceType || !location) {
      return bad(res, "All fields are required");
    }
    const conn = await pool.getConnection();
    try {
      const [r] = await conn.query(
        `INSERT INTO service_requests (customer_name, phone_number, service_type, location, user_id) VALUES (?,?,?,?,?)`,
        [customerName, phoneNumber, serviceType, location, userId || null]
      );
      ok(res, { message: "Request submitted", id: r.insertId });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error(e);
    bad(res, "Server error", 500);
  }
});

// Approve / Reject request (Mechanic)
app.put("/service-request/approve/:id", jwtMiddleware, async (req, res) => {
  if (req.user.userType !== "Mechanic") return bad(res, "Forbidden", 403);
  const reqId = Number(req.params.id);
  const mechanicId = req.user.id;
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(`SELECT * FROM service_requests WHERE id=?`, [reqId]);
      if (!rows.length) return bad(res, "Service request not found", 404);
      await conn.query(`UPDATE service_requests SET status='Approved', mechanic_id=? WHERE id=?`, [mechanicId, reqId]);
      ok(res, { message: "Request approved" });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error(e);
    bad(res, "Server error", 500);
  }
});

app.put("/service-request/reject/:id", jwtMiddleware, async (req, res) => {
  if (req.user.userType !== "Mechanic") return bad(res, "Forbidden", 403);
  const reqId = Number(req.params.id);
  try {
    const conn = await pool.getConnection();
    try {
      await conn.query(`UPDATE service_requests SET status='Rejected' WHERE id=?`, [reqId]);
      ok(res, { message: "Request rejected" });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error(e);
    bad(res, "Server error", 500);
  }
});

// Get requests of a user (public path for compatibility)
app.get("/service-requests/user/:userId", async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(`SELECT * FROM service_requests WHERE user_id=? ORDER BY created_at DESC`, [userId]);
      ok(res, { serviceRequests: rows });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error(e);
    bad(res, "Server error", 500);
  }
});

// Same but via JWT
app.get("/service-requests/user", jwtMiddleware, async (req, res) => {
  if (req.user.userType !== "Customer") return bad(res, "Forbidden", 403);
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(`SELECT * FROM service_requests WHERE user_id=? ORDER BY created_at DESC`, [req.user.id]);
      ok(res, { serviceRequests: rows });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error(e);
    bad(res, "Server error", 500);
  }
});

// Mechanic: availability & details
app.get("/mechanic/status", jwtMiddleware, async (req, res) => {
  if (req.user.userType !== "Mechanic") return bad(res, "Forbidden", 403);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(`SELECT is_available FROM mechanics WHERE id=?`, [req.user.id]);
    if (!rows.length) return bad(res, "Mechanic not found", 404);
    ok(res, { isAvailable: !!rows[0].is_available });
  } finally {
    conn.release();
  }
});

app.put("/mechanic/update-status", jwtMiddleware, async (req, res) => {
  if (req.user.userType !== "Mechanic") return bad(res, "Forbidden", 403);
  const { isAvailable } = req.body;
  if (typeof isAvailable === "undefined") return bad(res, "`isAvailable` is required");
  const conn = await pool.getConnection();
  try {
    await conn.query(`UPDATE mechanics SET is_available=? WHERE id=?`, [isAvailable ? 1 : 0, req.user.id]);
    ok(res, { message: "Availability updated" });
  } finally {
    conn.release();
  }
});

app.get("/mechanic/details", jwtMiddleware, async (req, res) => {
  if (req.user.userType !== "Mechanic") return bad(res, "Forbidden", 403);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(`SELECT id, name, username, mobile, email, is_available, latitude, longitude FROM mechanics WHERE id=?`, [req.user.id]);
    if (!rows.length) return bad(res, "Mechanic not found", 404);
    ok(res, { mechanic: rows[0] });
  } finally {
    conn.release();
  }
});

// Update profiles
app.put("/user/update/:id", jwtMiddleware, async (req, res) => {
  const id = Number(req.params.id);
  if (req.user.userType !== "Customer" || req.user.id !== id) return bad(res, "Forbidden", 403);
  const { Name, mobile, email } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.query(`UPDATE users SET name=?, mobile=?, email=? WHERE id=?`, [Name, mobile, email, id]);
    ok(res, { message: "Profile updated" });
  } finally {
    conn.release();
  }
});

app.put("/mechanic/update/:id", jwtMiddleware, async (req, res) => {
  const id = Number(req.params.id);
  if (req.user.userType !== "Mechanic" || req.user.id !== id) return bad(res, "Forbidden", 403);
  const { Name, mobile, email, latitude, longitude } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.query(`UPDATE mechanics SET name=?, mobile=?, email=?, latitude=?, longitude=? WHERE id=?`, [Name, mobile, email, latitude, longitude, id]);
    ok(res, { message: "Mechanic profile updated" });
  } finally {
    conn.release();
  }
});

// Mechanic: incoming requests
app.get("/mechanic/requests", jwtMiddleware, async (req, res) => {
  if (req.user.userType !== "Mechanic") return bad(res, "Forbidden", 403);
  const mechanicId = req.user.id;
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT * FROM service_requests WHERE status='Pending' OR mechanic_id=? ORDER BY created_at DESC`,
      [mechanicId]
    );
    ok(res, { serviceRequests: rows });
  } finally {
    conn.release();
  }
});

// Delete profile
app.delete("/delete-profile/:id", jwtMiddleware, async (req, res) => {
  const id = Number(req.params.id);
  const conn = await pool.getConnection();
  try {
    if (req.user.userType === "Mechanic" && req.user.id === id) {
      await conn.query(`DELETE FROM mechanics WHERE id=?`, [id]);
      ok(res, { message: "Mechanic profile deleted successfully" });
    } else if (req.user.userType === "Customer" && req.user.id === id) {
      await conn.query(`DELETE FROM users WHERE id=?`, [id]);
      ok(res, { message: "User profile deleted successfully" });
    } else {
      return bad(res, "Forbidden", 403);
    }
  } finally {
    conn.release();
  }
});

// Get user info (JWT)
app.get("/user-info", jwtMiddleware, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    if (req.user.userType === "Mechanic") {
      const [rows] = await conn.query(`SELECT id, name, username, mobile, email, user_type FROM mechanics WHERE id=?`, [req.user.id]);
      if (!rows.length) return bad(res, "Mechanic not found", 404);
      ok(res, { user: rows[0] });
    } else {
      const [rows] = await conn.query(`SELECT id, name, username, mobile, email, user_type FROM users WHERE id=?`, [req.user.id]);
      if (!rows.length) return bad(res, "User not found", 404);
      ok(res, { user: rows[0] });
    }
  } finally {
    conn.release();
  }
});

// Forgot/reset password (token logged to server)
app.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return bad(res, "Email is required");
  const conn = await pool.getConnection();
  try {
    // find in users or mechanics
    const [u] = await conn.query(`SELECT id,'Customer' as user_type FROM users WHERE email=? UNION SELECT id,'Mechanic' as user_type FROM mechanics WHERE email=?`, [email, email]);
    if (!u.length) return bad(res, "Email not found", 404);
    const row = u[0];
    const crypto = await import("crypto");
    const token = crypto.randomBytes(24).toString("hex");
    const expires = new Date(Date.now() + 1000 * 60 * 30); // 30 min
    await conn.query(`INSERT INTO password_reset_tokens (user_type,user_id,token,expires_at) VALUES (?,?,?,?)`, [row.user_type, row.id, token, expires]);
    console.log("[Password Reset] Send this token to user via email:", token);
    ok(res, { message: "Reset link generated and will be emailed if SMTP configured." });
  } finally {
    conn.release();
  }
});

app.post("/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return bad(res, "Token and new password are required");
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(`SELECT * FROM password_reset_tokens WHERE token=? AND expires_at > NOW()`, [token]);
    if (!rows.length) return bad(res, "Invalid or expired token", 400);
    const t = rows[0];
    const pwdHash = await hash(newPassword);
    if (t.user_type === "Mechanic") {
      await conn.query(`UPDATE mechanics SET password_hash=? WHERE id=?`, [pwdHash, t.user_id]);
    } else {
      await conn.query(`UPDATE users SET password_hash=? WHERE id=?`, [pwdHash, t.user_id]);
    }
    await conn.query(`DELETE FROM password_reset_tokens WHERE id=?`, [t.id]);
    ok(res, { message: "Password updated" });
  } finally {
    conn.release();
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
