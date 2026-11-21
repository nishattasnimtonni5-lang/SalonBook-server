import { Router } from "express";
import appointmentRouter from "./appointments/index.js";

// All API routes live under /api (see app.js).

const router = Router();

// GET /api/health — quick check that the server is up.
router.get("/test", (req, res) => {
  res.send({ success: true, data: { status: "ok" }, message: "API is running" });
});

router.use("/bookings", appointmentRouter);

export default router;