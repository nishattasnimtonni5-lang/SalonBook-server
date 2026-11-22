import { Router } from "express";
import appointmentRouter from "./appointments/index.js";



const router = Router();


router.get("/test", (req, res) => {
  res.send({ success: true, data: { status: "ok" }, message: "API is running" });
});

router.use("/bookings", appointmentRouter);

export default router;