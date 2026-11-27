import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import nodemailer from "nodemailer";
import Stripe from "stripe";
import "dotenv/config";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import jwt from "jsonwebtoken";

const app = express();
const PORT = 8000;

const JWT_SECRET = process.env.JWT_SECRET;
const isProduction = process.env.NODE_ENV === "production";

const cookieOptions = {
  httpOnly: true,
  // Cross-site API calls from the frontend domain need SameSite=None.
  secure: true,
  sameSite: "none",
  maxAge: 15 * 60 * 1000,
  path: "/",
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
    throw err;
  }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("SalonBook");
const usersCollection = database.collection("user");
const servicesCollection = database.collection("services");
const appointmentsCollection = database.collection("appointments");
const reportsCollection = database.collection("reports");
const offersCollection = database.collection("offers");
const transactionsCollection = database.collection("transactions");

const auth = betterAuth({
  database: mongodbAdapter(database, {
    client: connectedClient,
  }),

  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "customer",
        input: false,
      },
    },
  },

  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: [
    "http://localhost:3000",
    process.env.CLIENT_URL || "https://salon-book-a-06.vercel.app",
  ],
  // Frontend and backend are on different domains, so the OAuth state
  // cookie set on a cross-site fetch is partitioned/blocked by browsers.
  // State is still verified against the DB verification record + PKCE.
  account: {
    skipStateCookieCheck: true,
  },
  // Let the session cookie be sent on cross-site API calls
  // (frontend and backend are on different domains).
  // NOTE: this better-auth version reads overrides from
  // advanced.defaultCookieAttributes, not advanced.cookie.
  advanced: {
    defaultCookieAttributes: {
      sameSite: "none",
      secure: true,
    },
  },
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
  },
});

const requireAdmin = async (req, res, next) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session) {
      return res.status(401).send({
        message: "Unauthorized. Please login first.",
      });
    }

    if (session.user.role !== "admin") {
      return res.status(403).send({
        message: "Access denied. Admin only.",
      });
    }

    req.user = session.user;
    next();
  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Authentication failed.",
    });
  }
};


const requireActiveUser = async (req, res, next) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session) {
      return res.status(401).send({
        message: "Please login first.",
      });
    }

    if (!session) {
  return res.status(401).send({
    message: "Please login first.",
  });
}

console.log("Logged in user ID:", session.user.id);
console.log("Logged in user:", session.user);
    
      const user = await usersCollection.findOne({
  _id: new ObjectId(session.user.id),
});

    if (!user) {
      return res.status(401).send({
        message: "User not found.",
      });
    }

    if (user.isBlocked === true) {
      return res.status(403).send({
        message: "Your account has been blocked.",
      });
    }

    req.user = session.user;
    next();
  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Authentication failed.",
    });
  }
};

const verifyJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  } else {
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      const cookies = cookieHeader.split(";").map((c) => c.trim().split("="));
      const found = cookies.find(([name]) => name === "token");
      if (found) token = found[1];
    }
  }

  if (!token) {
    return res.status(401).send({ message: "Missing or invalid authorization" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: "salonbook",
      audience: "salonbook-api",
    });

    req.user = {
      id: decoded.userId,
      role: decoded.role,
      email: decoded.email,
    };

    next();
  } catch (error) {
    return res.status(401).send({ message: "Invalid or expired token" });
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).send({ message: "Forbidden: insufficient role" });
  }
  next();
};

const requireAdminJWT = (req, res, next) => requireRole("admin")(req, res, next);
const requireCustomerJWT = (req, res, next) => requireRole("customer")(req, res, next);

const REPORT_CATEGORIES = [
  "Service Quality",
  "Staff Behaviour",
  "Payment Issue",
  "appointment Issue",
  // The client form (src/lib/reports.ts) offers "Booking Issue"; accept it
  // too so that choice doesn't fail server-side validation with a 400.
  "Booking Issue",
  "Inappropriate Behaviour / Abuse",
  "Other",
];

// Booking states and their safe transitions. "completed" and "cancelled"
// are terminal; "confirmed" is only reached from "pending" (verified
// Stripe webhook or an explicit admin action). paymentStatus is NOT part
// of this table — it is written exclusively by the Stripe webhook.
const APPOINTMENT_STATUSES = ["pending", "confirmed", "completed", "cancelled"];

const STATUS_TRANSITIONS = {
  pending: ["confirmed", "cancelled", "completed"],
  confirmed: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

// Public base URL that the Stripe success/cancel redirects point at.
function resolveClientBaseUrl() {
  const clientUrl =
    process.env.CLIENT_URL ||
    (process.env.NODE_ENV === "production"
      ? undefined
      : "http://localhost:3000");

  if (!clientUrl) return null;

  try {
    const parsed = new URL(clientUrl);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildAdminReportEmail(report) {
  const rows = [
    ["Report ID", report._id.toString()],
    ["Status", report.status],
    ["Submitted at", report.submittedAt.toUTCString()],
    ["Customer name", report.customerName],
    ["Customer email", report.customerEmail],
    ["Issue category", report.category],
    ["Subject", report.subject],
    ["Related service", report.relatedService || "—"],
    ["Appointment ID", report.appointmentId || "—"],
  ];

  const tableRows = rows
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #e4e4e7;color:#52525b;font-size:13px;white-space:nowrap;vertical-align:top;">
            ${escapeHtml(label)}
          </td>
          <td style="padding:10px 14px;border-bottom:1px solid #e4e4e7;color:#18181b;font-size:13px;vertical-align:top;">
            ${escapeHtml(value)}
          </td>
        </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
            <tr>
              <td style="background-color:#b0764a;padding:20px 24px;">
                <h1 style="margin:0;font-size:18px;color:#ffffff;font-weight:bold;">
                  SalonBook — New Issue Report
                </h1>
                <p style="margin:6px 0 0;font-size:13px;color:#f5e6da;">
                  A customer has submitted a new report that needs review.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e4e4e7;border-radius:8px;">
                  ${tableRows}
                </table>

                <h2 style="margin:24px 0 8px;font-size:14px;color:#18181b;">Description</h2>
                <div style="padding:14px;background-color:#f4f4f5;border-radius:8px;font-size:13px;color:#27272a;line-height:1.6;white-space:pre-wrap;">${escapeHtml(report.description)}</div>

                <p style="margin:20px 0 0;font-size:12px;color:#71717a;">
                  This is an automated notification from the SalonBook reporting system. Please follow up with the customer at the email address above.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendAdminReportEmail(report) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ADMIN_EMAIL } =
    process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ADMIN_EMAIL) {
    console.log(
      "Report saved, but admin email skipped: SMTP/ADMIN_EMAIL is not configured."
    );
    return;
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: `"SalonBook Reports" <${SMTP_USER}>`,
    to: ADMIN_EMAIL,
    subject: `[SalonBook] New issue report: ${report.category} — ${report.subject}`,
    html: buildAdminReportEmail(report),
  });
}

app.use(cors({
  // Allow both the deployed client and local dev — matches BetterAuth's
  // trustedOrigins below so cross-origin sign-in works from either origin.
  origin: [
    process.env.CLIENT_URL || "https://salon-book-a-06.vercel.app",
    "http://localhost:3000",
  ],
  credentials: true,
}));

app.post(
  "/api/webhooks/stripe",
  (req, res, next) => {
    console.log("WEBHOOK REQUEST RECEIVED");
    next();
  },
  express.raw({ type: "application/json" }),
  async (req, res) => {
    console.log("WEBHOOK ROUTE HIT");
    const signature = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.log("Stripe webhook verification failed:", error.message);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    console.log("Stripe event received:", event.type);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const appointmentId = session.metadata?.appointmentId;
      console.log("FULL SESSION METADATA:", session.metadata);
      console.log("SESSION ID:", session.id);
      console.log(
        "Payment completed for appointment:",
        appointmentId
      );

      if (!appointmentId || !ObjectId.isValid(appointmentId)) {
        console.log("Invalid appointment ID in Stripe metadata");
        return res.status(400).send({
          message: "Invalid appointment ID",
        });
      }

      // Never mark as paid unless Stripe confirms the money was collected.
      if (session.payment_status !== "paid") {
        console.log(
          "Session completed without payment; no update applied:",
          session.id
        );
        return res.json({ received: true });
      }

      try {
        // One atomic update guarded by paymentStatus !== "paid":
        // - a duplicate/replayed webhook matches nothing (idempotent,
        //   no duplicate updates and no second appointment is created),
        // - paymentStatus/paidAt only ever change here, on a
        //   signature-verified event,
        // - status only moves pending -> confirmed, so cancelled or
        //   completed bookings are never resurrected and the booking
        //   status/payment status never overwrite each other.
        const result = await appointmentsCollection.updateOne(
          {
            _id: new ObjectId(appointmentId),
            paymentStatus: { $ne: "paid" },
          },
          [
            {
              $set: {
                paymentStatus: "paid",
                paidAt: new Date(),
                stripeSessionId: session.id,
              },
            },
            {
              $set: {
                status: {
                  $cond: [
                    { $eq: ["$status", "pending"] },
                    "confirmed",
                    { $ifNull: ["$status", "pending"] },
                  ],
                },
              },
            },
          ]
        );

        if (result.matchedCount === 0) {
          console.log(
            "Appointment already paid; duplicate webhook ignored:",
            appointmentId
          );
        } else {
          console.log("Appointment updated:", result.modifiedCount);
        }

        const updatedAppointment = await appointmentsCollection.findOne({
          _id: new ObjectId(appointmentId),
        });

        if (updatedAppointment) {
          const transactionDoc = {
            appointmentId: updatedAppointment._id,
            userId: updatedAppointment.userId,
            customerName: updatedAppointment.customerName || session.customer_details?.name || "Customer",
            customerEmail: updatedAppointment.customerEmail || session.customer_details?.email || "",
            serviceId: updatedAppointment.serviceId,
            serviceName: updatedAppointment.serviceName,
            serviceImage: updatedAppointment.serviceImage,
            appointmentDate: updatedAppointment.date,
            appointmentTime: updatedAppointment.time,
            paymentAmount: session.amount_total ? session.amount_total / 100 : Number(updatedAppointment.price),
            currency: (session.currency || "usd").toUpperCase(),
            stripeSessionId: session.id,
            paymentStatus: "paid",
            transactionDate: updatedAppointment.paidAt || new Date(),
            createdAt: new Date(),
          };

          await transactionsCollection.updateOne(
            { stripeSessionId: session.id },
            { $set: transactionDoc },
            { upsert: true }
          );
          console.log("Transaction saved in transactions collection for:", session.id);
        }
      } catch (error) {
        console.log("Appointment update failed:", error);
        // Non-2xx so Stripe retries and the payment is not lost.
        return res.status(500).send({
          message: "Appointment update failed",
        });
      }
    }

    res.json({ received: true });
  }
);

app.all("/api/auth/*splat", toNodeHandler(auth));
app.use(express.json());
console.log("CHECKOUT ROUTE ENTERED");

app.post("/auth/token", async (req, res) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session || !session.user) {
      return res.status(401).send({ message: "Unauthorized. Please login first." });
    }

    const token = jwt.sign(
      {
        userId: session.user.id,
        role: session.user.role,
        email: session.user.email,
      },
      JWT_SECRET,
      {
        algorithm: "HS256",
        expiresIn: "15m",
        issuer: "salonbook",
        audience: "salonbook-api",
      }
    );

    res.cookie("token", token, cookieOptions);

    return res.send({
      success: true,
      message: "JWT issued",
      data: { token },
    });
  } catch (error) {
    console.error("JWT issuance error:", error);
    return res.status(500).send({ message: "Failed to issue token" });
  }
});

app.post("/auth/logout", async (req, res) => {
  res.clearCookie("token", { path: "/" });
  return res.send({ success: true, message: "Logged out" });
});

app.get("/auth/test-jwt", verifyJWT, async (req, res) => {
  return res.send({ success: true, user: req.user });
});

app.post("/bookings/create-checkout-session",requireActiveUser, async (req, res) => {
  try {
    const clientBaseUrl = resolveClientBaseUrl();

    if (!clientBaseUrl) {
      return res.status(500).send({
        message: "Checkout is not configured",
      });
    }

    const payload = req.body;

    if (!ObjectId.isValid(payload.serviceId)) {
      return res.status(400).send({
        message: "Invalid service ID",
      });
    }

    const service = await servicesCollection.findOne({
      _id: new ObjectId(payload.serviceId),
      status: "active",
    });

    if (!service) {
      return res.status(404).send({
        message: "Service not found or inactive",
      });
    }

    // Initial booking state: booking and payment are both unconfirmed.
    // These two fields are independent and can only change through the
    // booking flow and the verified Stripe webhook — never from a client
    // request.
    const appointmentResult = await appointmentsCollection.insertOne({
      serviceId: payload.serviceId,
      serviceName: service.name,
      serviceImage: service.image,
      price: service.price,
      duration: service.duration,
      userId: req.user.id,
customerName: req.user.name,
customerEmail: req.user.email,
      date: payload.date,
      time: payload.time,
      status: "pending",
      paymentStatus: "unpaid",
      paidAt: null,
      refundStatus: "none",
      createdAt: new Date(),
    });

    console.log(
      "CREATING CHECKOUT FOR:",
      appointmentResult.insertedId.toString()
    );

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: service.name,
              description: service.description,
            },
            unit_amount: Math.round(Number(service.price) * 100),
          },
          quantity: 1,
        },
      ],

      success_url: new URL(
        `/appointment/success?appointmentId=${appointmentResult.insertedId}&session_id={CHECKOUT_SESSION_ID}`,
        clientBaseUrl
      ).toString(),

      cancel_url: new URL(
        `/appointment/cancel?appointmentId=${appointmentResult.insertedId}`,
        clientBaseUrl
      ).toString(),

      mode: "payment",

      metadata: {
        appointmentId: appointmentResult.insertedId.toString(),
        userId: req.user.id,
      },
    });

    console.log("CREATED SESSION:", session.id);
    console.log("CREATED METADATA:", session.metadata);

    res.send({
      success: true,
      message: "Checkout session created",
      data: {
        redirectUrl: session.url,
      },
    });
  } catch (error) {
    console.error("Checkout session error:", error);

    res.status(500).send({
      message: "Failed to create checkout session",
    });
  }
});

// Creates a Stripe checkout for an existing unpaid appointment ("Pay now").
// It never marks the appointment as paid itself — only the verified Stripe
// webhook can move paymentStatus to "paid".
app.post("/bookings/:id/checkout", requireActiveUser, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid appointment ID",
      });
    }

    const appointment = await appointmentsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!appointment) {
      return res.status(404).send({
        message: "Appointment not found",
      });
      if (appointment.userId !== req.user.id) {
  return res.status(403).send({
    message: "You are not allowed to access this booking.",
  });
}
    }

    // A paid booking must never be sent back through a redirect that could
    // later be mistaken for a failed/unpaid state.
    if (appointment.paymentStatus === "paid") {
      return res.status(409).send({
        message: "This appointment is already paid.",
      });
    }

    if (["cancelled", "completed"].includes(appointment.status)) {
      return res.status(409).send({
        message: "This appointment can no longer be paid for.",
      });
    }

    const clientBaseUrl = resolveClientBaseUrl();

    if (!clientBaseUrl) {
      return res.status(500).send({
        message: "Checkout is not configured",
      });
    }

    let description = "";
    if (ObjectId.isValid(appointment.serviceId)) {
      const service = await servicesCollection.findOne({
        _id: new ObjectId(appointment.serviceId),
      });
      description = service?.description ?? "";
    }

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: appointment.serviceName,
              description,
            },
            unit_amount: Math.round(Number(appointment.price) * 100),
          },
          quantity: 1,
        },
      ],
      success_url: new URL(
        `/appointment/success?appointmentId=${appointment._id}&session_id={CHECKOUT_SESSION_ID}`,
        clientBaseUrl
      ).toString(),
      cancel_url: new URL(
        `/appointment/cancel?appointmentId=${appointment._id}`,
        clientBaseUrl
      ).toString(),
      mode: "payment",
      metadata: {
        appointmentId: appointment._id.toString(),
        userId: appointment.userId ?? "",
      },
    });

    res.send({
      success: true,
      message: "Checkout session created",
      data: {
        redirectUrl: session.url,
      },
    });
  } catch (error) {
    console.error("Checkout retry error:", error);

    res.status(500).send({
      message: "Failed to create checkout session",
    });
  }
});

// Verified customer cancellation. The request must come from the booking
// owner, the appointment must still be cancellable, and paymentStatus is
// never changed here — a paid booking stays paid until a refund is
// processed separately (tracked via refundStatus).
app.post("/bookings/:id/cancel", requireActiveUser, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid appointment ID",
      });
    }

    const appointment = await appointmentsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!appointment) {
      return res.status(404).send({
        message: "Appointment not found",
      });
      if (appointment.userId !== req.user.id) {
  return res.status(403).send({
    message: "You are not allowed to cancel this booking.",
  });
}
    }

    const requesterId =
      typeof req.body?.userId === "string" ? req.body.userId.trim() : "";

    if (!requesterId) {
      return res.status(401).send({
        message: "Sign in to cancel this appointment.",
      });
    }

    // Only the customer who booked the appointment may cancel it.
    if (appointment.userId && appointment.userId !== requesterId) {
      return res.status(403).send({
        message: "You can only cancel your own appointments.",
      });
    }

    // Idempotent: cancelling twice is not an error, but it is a no-op.
    if (appointment.status === "cancelled") {
      return res.send({
        success: true,
        modifiedCount: 0,
        appointment,
        message: "This appointment is already cancelled.",
      });
    }

    // Eligibility check: only a pending/confirmed booking may be cancelled.
    if (!["pending", "confirmed"].includes(appointment.status)) {
      return res.status(409).send({
        message: "This appointment can no longer be cancelled.",
      });
    }

    // Atomic and guarded on the eligibility we just verified, so a
    // concurrent webhook/admin update cannot be silently overwritten.
    // status and paymentStatus stay independent: only `status` changes.
    const result = await appointmentsCollection.updateOne(
      { _id: new ObjectId(id), status: { $in: ["pending", "confirmed"] } },
      { $set: { status: "cancelled", cancelledAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      const latest = await appointmentsCollection.findOne({
        _id: new ObjectId(id),
      });
      return res.status(409).send({
        message: "This appointment is no longer cancellable.",
        appointment: latest,
      });
    }

    const updated = await appointmentsCollection.findOne({
      _id: new ObjectId(id),
    });

    res.send({
      success: true,
      modifiedCount: result.modifiedCount,
      appointment: updated,
    });
  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Failed to cancel appointment",
    });
  }
});

// Verified payment confirmation & transaction retrieval:
// Verifies Stripe checkout session, updates appointment paymentStatus to "paid",
// stores transaction in the `transactions` collection, and returns the transaction details.
app.get("/bookings/verify-session", async (req, res) => {
  try {
    const { session_id, appointmentId } = req.query;

    if (!session_id && !appointmentId) {
      return res.status(400).send({ message: "session_id or appointmentId is required" });
    }

    let session = null;
    if (session_id) {
      try {
        session = await stripe.checkout.sessions.retrieve(session_id);
      } catch (stripeErr) {
        console.log("Could not retrieve Stripe session directly:", stripeErr.message);
      }
    }

    const targetAppointmentId =
      session?.metadata?.appointmentId || appointmentId;

    if (!targetAppointmentId || !ObjectId.isValid(targetAppointmentId)) {
      return res.status(400).send({ message: "Invalid appointment ID" });
    }

    let appointment = await appointmentsCollection.findOne({
      _id: new ObjectId(targetAppointmentId),
    });

    if (!appointment) {
      return res.status(404).send({ message: "Appointment not found" });
    }

    const isSessionPaid = session?.payment_status === "paid";
    const isAlreadyPaid = appointment.paymentStatus === "paid";

    if (isSessionPaid || isAlreadyPaid) {
      if (!isAlreadyPaid) {
        await appointmentsCollection.updateOne(
          { _id: new ObjectId(targetAppointmentId) },
          {
            $set: {
              paymentStatus: "paid",
              paidAt: new Date(),
              stripeSessionId: session?.id || appointment.stripeSessionId || null,
              status: appointment.status === "pending" ? "confirmed" : appointment.status,
            },
          }
        );
        appointment = await appointmentsCollection.findOne({
          _id: new ObjectId(targetAppointmentId),
        });
      }

      const stripeSessionId = session?.id || appointment.stripeSessionId || `ref_${appointment._id}`;
      const paymentAmount = session?.amount_total
        ? session.amount_total / 100
        : Number(appointment.price);

      const transactionDoc = {
        appointmentId: appointment._id,
        userId: appointment.userId,
        customerName:
          appointment.customerName ||
          session?.customer_details?.name ||
          "Customer",
        customerEmail:
          appointment.customerEmail ||
          session?.customer_details?.email ||
          "",
        serviceId: appointment.serviceId,
        serviceName: appointment.serviceName,
        serviceImage: appointment.serviceImage,
        appointmentDate: appointment.date,
        appointmentTime: appointment.time,
        paymentAmount,
        currency: (session?.currency || "usd").toUpperCase(),
        stripeSessionId,
        paymentStatus: "paid",
        transactionDate: appointment.paidAt || new Date(),
        createdAt: new Date(),
      };

      await transactionsCollection.updateOne(
        { appointmentId: appointment._id },
        { $set: transactionDoc },
        { upsert: true }
      );

      const transaction = await transactionsCollection.findOne({
        appointmentId: appointment._id,
      });

      return res.send({
        success: true,
        verified: true,
        appointment,
        transaction,
      });
    }

    res.send({
      success: true,
      verified: false,
      appointment,
      transaction: null,
    });
  } catch (error) {
    console.error("Session verification error:", error);
    res.status(500).send({ message: "Failed to verify session" });
  }
});

app.get("/transactions/:appointmentId", async (req, res) => {
  try {
    const { appointmentId } = req.params;
    if (!ObjectId.isValid(appointmentId)) {
      return res.status(400).send({ message: "Invalid appointment ID" });
    }
    const transaction = await transactionsCollection.findOne({
      appointmentId: new ObjectId(appointmentId),
    });
    if (!transaction) {
      return res.status(404).send({ message: "Transaction not found" });
    }
    res.send(transaction);
  } catch (error) {
    console.error("Fetch transaction error:", error);
    res.status(500).send({ message: "Failed to fetch transaction" });
  }
});


app.get("/", (req, res) => {
  res.send({
    message: "Server is running",
  });
});

app.get("/services", async (req, res) => {
  try {
    const services = await servicesCollection
      .find({ status: "active" })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).send(services);
  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Failed to fetch services",
    });
  }
});

app.get("/services/featured", async (req, res) => {
  try {
    const services = await servicesCollection
      .find({
        status: "active",
        featured: true,
      })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    res.status(200).send(services);
  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Failed to fetch featured services",
    });
  }
});

app.post("/appointments",requireActiveUser, async (req, res) => {
  try {
    // Clients may never choose booking/payment state: strip anything that
    // belongs to the booking flow or the verified Stripe webhook.
    const appointmentData = { ...(req.body ?? {}) };
    delete appointmentData.status;
    delete appointmentData.paymentStatus;
    delete appointmentData.paidAt;
    delete appointmentData.cancelledAt;
    delete appointmentData.refundStatus;

    const result = await appointmentsCollection.insertOne({
  ...appointmentData,
  userId: req.user.id,
  status: "pending",
  paymentStatus: "unpaid",
  paidAt: null,
  refundStatus: "none",
  createdAt: new Date(),
});

    res.send({
      success: true,
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Failed to book appointment",
    });
  }
});

app.patch("/appointments/:id",requireAdmin,  async (req, res) => {
  try {
    const { id } = req.params;
    const { status, paymentStatus } = req.body ?? {};

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid appointment ID",
      });
    }

    // paymentStatus is written exclusively by the verified Stripe webhook;
    // no frontend/admin request may set it (especially not "paid").
    if (paymentStatus !== undefined) {
      return res.status(400).send({
        message:
          "Payment status cannot be changed here; it is only updated by the Stripe webhook.",
      });
    }

    if (!status || !APPOINTMENT_STATUSES.includes(status)) {
      return res.status(400).send({
        message: "Choose a valid appointment status.",
      });
    }

    const appointment = await appointmentsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!appointment) {
      return res.status(404).send({
        message: "Appointment not found",
      });
    }

    const currentStatus = appointment.status || "pending";

    // Re-applying the current status is a harmless no-op.
    if (currentStatus === status) {
      return res.send({
        success: true,
        modifiedCount: 0,
        message: "Appointment already has this status.",
      });
    }

    const allowedNext = STATUS_TRANSITIONS[currentStatus];
    if (allowedNext && !allowedNext.includes(status)) {
      return res.status(409).send({
        message: `An appointment cannot change from "${currentStatus}" to "${status}".`,
      });
    }

    const update = { status };

    if (status === "cancelled") {
      // Booking state only: paymentStatus/paidAt are left untouched so a
      // paid booking keeps its payment record (refunds use refundStatus).
      update.cancelledAt = new Date();
    }

    // Guarded on the status we just read so a concurrent update cannot
    // silently overwrite a different transition.
    const result = await appointmentsCollection.updateOne(
      { _id: new ObjectId(id), status: currentStatus },
      { $set: update }
    );

    if (result.matchedCount === 0) {
      return res.status(409).send({
        message:
          "Appointment status changed at the same time. Please refresh and try again.",
      });
    }

    res.send({
      success: true,
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Failed to update appointment",
    });
  }
});

// Single-appointment lookup used by the success/cancel pages to verify the
// real MongoDB state instead of assuming it from the Stripe redirect.
app.get("/appointments/:id",   requireActiveUser,async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid appointment ID",
      });
    }

    const appointment = await appointmentsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!appointment) {
      return res.status(404).send({
        message: "Appointment not found",
      });
    }

    res.send(appointment);
  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Failed to fetch appointment",
    });
  }
});

app.get("/appointments", async (req, res) => {
  try {
    // Allow internal Next.js server calls via shared secret (admin panel)
    const internalSecret = process.env.INTERNAL_API_SECRET;
    if (internalSecret && req.headers["x-internal-secret"] === internalSecret) {
      const result = await appointmentsCollection.find({}).toArray();
      return res.send(result);
    }

    // Otherwise require an active user session
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session?.user) {
      return res.status(401).send({ message: "Please login first." });
    }
    const user = await usersCollection.findOne({ _id: new ObjectId(session.user.id) });
    if (!user) return res.status(401).send({ message: "User not found." });
    if (user.isBlocked) return res.status(403).send({ message: "Your account has been blocked." });

    const query = session.user.role === "admin" ? {} : { userId: session.user.id };
    const result = await appointmentsCollection.find(query).toArray();
    res.send(result);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Failed to fetch appointments" });
  }
});

app.post("/reports", async (req, res) => {
  try {
    const secret = process.env.INTERNAL_API_SECRET;

    if (!secret || req.headers["x-internal-secret"] !== secret) {
      return res.status(401).send({
        message: "Unauthorized",
      });
    }

    const {
      userId,
      customerName,
      customerEmail,
      category,
      subject,
      relatedService,
      appointmentId,
      description,
    } = req.body ?? {};

    const requiredStrings = {
      userId,
      customerName,
      customerEmail,
      category,
      subject,
      description,
    };

    for (const [field, value] of Object.entries(requiredStrings)) {
      if (typeof value !== "string" || !value.trim()) {
        return res.status(400).send({
          message: `${field} is required.`,
        });
      }
    }

    if (!REPORT_CATEGORIES.includes(category)) {
      return res.status(400).send({
        message: "Invalid issue category.",
      });
    }

    if (subject.trim().length > 200) {
      return res.status(400).send({
        message: "Subject must be 200 characters or fewer.",
      });
    }

    if (description.trim().length > 5000) {
      return res.status(400).send({
        message: "Description must be 5000 characters or fewer.",
      });
    }

    const report = {
      userId: userId.trim(),
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim(),
      category: category.trim(),
      subject: subject.trim(),
      relatedService:
        typeof relatedService === "string"
          ? relatedService.trim()
          : "",
      appointmentId:
        typeof appointmentId === "string"
          ? appointmentId.trim()
          : "",
      description: description.trim(),
      status: "Pending",
      submittedAt: new Date(),
    };

    const result = await reportsCollection.insertOne(report);
    report._id = result.insertedId;

    try {
      await sendAdminReportEmail(report);
    } catch (error) {
      console.log("Failed to send admin report email:", error);
    }

    res.status(201).send({
      success: true,
      insertedId: result.insertedId,
      message:
        "Your report has been submitted. Our team will review it shortly.",
    });
  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Failed to submit report",
    });
  }
});

// List every submitted report for the admin dashboard. Reached through the
// Next.js /api/admin/reports proxy, which already verified the admin session;
// the shared internal secret proves the call comes from our own server.
app.get("/reports", async (req, res) => {
  try {
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret || req.headers["x-internal-secret"] !== secret) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    const reports = await reportsCollection
      .find({})
      .sort({ submittedAt: -1 })
      .toArray();
    res.status(200).send(reports);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Failed to fetch reports" });
  }
});

// Move a report between pending / reviewed / resolved (admin dashboard).
app.patch("/reports/:id", async (req, res) => {
  try {
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret || req.headers["x-internal-secret"] !== secret) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    const { status } = req.body ?? {};
    const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
    if (!["pending", "reviewed", "resolved"].includes(normalized)) {
      return res.status(400).send({ message: "Choose a valid report status." });
    }

    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(404).send({ message: "Report not found." });
    }

    // Existing documents store Title-case statuses ("Pending"); keep that.
    const titleCase = normalized.charAt(0).toUpperCase() + normalized.slice(1);
    const result = await reportsCollection.updateOne(
      { _id: id },
      { $set: { status: titleCase, updatedAt: new Date() } }
    );
    if (!result.matchedCount) {
      return res.status(404).send({ message: "Report not found." });
    }

    res.status(200).send({ success: true, message: "Report updated." });
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Failed to update report" });
  }
});

app.post("/services",requireAdmin, async (req, res) => {
  try {
    const serviceData = req.body;

    const {
      name,
      category,
      price,
      duration,
      description,
      image,
      featured,
      status,
    } = serviceData;

    if (
      !name ||
      !category ||
      price === undefined ||
      !duration ||
      !description ||
      !image
    ) {
      return res.status(400).send({
        message: "Please provide all required service information.",
      });
    }

    const newService = {
      name,
      category,
      price: Number(price),
      duration: Number(duration),
      description,
      image,
      featured: featured === true,
      status: status || "active",
      createdAt: new Date(),
    };

    const result = await servicesCollection.insertOne(newService);

    res.status(201).send({
      success: true,
      message: "Service added successfully!",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Failed to add service.",
    });
  }
});

app.get("/admin/services", requireAdmin, async (req, res) => {
  try {
    const services = await servicesCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).send(services);
  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Failed to fetch all services",
    });
  }
});

app.patch("/services/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid service ID",
      });
    }

    const {
      name,
      category,
      price,
      duration,
      description,
      image,
      featured,
      status,
    } = req.body;

    if (
      !name ||
      !category ||
      price === undefined ||
      !duration ||
      !description ||
      !image
    ) {
      return res.status(400).send({
        message: "Please provide all required service information.",
      });
    }

    const updatedService = {
      name,
      category,
      price: Number(price),
      duration: Number(duration),
      description,
      image,
      featured: featured === true,
      status: status || "active",
      updatedAt: new Date(),
    };

    const result = await servicesCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updatedService }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        message: "Service not found",
      });
    }

    res.status(200).send({
      success: true,
      message: "Service updated successfully!",
    });
  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Failed to update service",
    });
  }
});


app.delete("/services/:id",  requireAdmin,async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid service ID",
      });
    }

    const result = await servicesCollection.deleteOne({
      _id: new ObjectId(id),
    });

    if (result.deletedCount === 0) {
      return res.status(404).send({
        message: "Service not found",
      });
    }

    res.status(200).send({
      success: true,
      message: "Service deleted successfully!",
    });
  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Failed to delete service",
    });
  }
});


app.post("/offers", async (req, res) => {
  try {
    const {
      title,
      image,
      description,
      discountType,
      discountValue,
      category,
      startDate,
      expiryDate,
      promoCode,
      status,
    } = req.body;

    if (
      !title ||
      !description ||
      !discountType ||
      discountValue === undefined ||
      !expiryDate
    ) {
      return res.status(400).send({
        message: "Please provide all required offer information.",
      });
    }

    const offerStatus = status || "active";

    if (
      !["percentage", "fixed"].includes(discountType) ||
      !["active", "inactive"].includes(offerStatus)
    ) {
      return res.status(400).send({
        message: "Invalid offer information.",
      });
    }

    const value = Number(discountValue);

    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      (discountType === "percentage" && value > 100)
    ) {
      return res.status(400).send({
        message: "Invalid discount value.",
      });
    }

    if (new Date(expiryDate) < new Date(startDate)) {
      return res.status(400).send({
        message: "Expiry date must be after start date.",
      });
    }

    // The admin form (via Next.js /api/admin/offers) sends couponCode /
    // applicableService / terms / minBookingAmount instead of promoCode /
    // category / startDate / image. Store both shapes so every reader —
    // filterValidOffers, manage-offers, the customer browser — finds its
    // fields, with defaults for whatever the caller didn't send.
    const applicableService =
      typeof req.body.applicableService === "string"
        ? req.body.applicableService.trim()
        : "";
    const couponCode =
      typeof req.body.couponCode === "string" ? req.body.couponCode.trim() : "";
    const terms = typeof req.body.terms === "string" ? req.body.terms : "";

    const newOffer = {
      title,
      image: typeof image === "string" ? image : "",
      description,
      discountType,
      discountValue: value,
      category: category || applicableService || "All services",
      startDate: startDate || new Date().toISOString().slice(0, 10),
      expiryDate,
      promoCode: promoCode || couponCode || "",
      status: offerStatus,
      ...(applicableService ? { applicableService } : {}),
      ...(couponCode ? { couponCode } : {}),
      ...(terms ? { terms } : {}),
      ...(req.body.minBookingAmount !== undefined
        ? { minBookingAmount: Number(req.body.minBookingAmount) || 0 }
        : {}),
      createdAt: new Date(),
    };

    const result = await offersCollection.insertOne(newOffer);

    res.status(201).send({
      success: true,
      message: "Offer published successfully!",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Failed to publish offer.",
    });
  }
});

app.get("/offers", async (req, res) => {
  try {
    const offers = await offersCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).send(offers);
  } catch (error) {
    console.log(error);
    res.status(500).send({
      message: "Failed to fetch offers.",
    });
  }
});

// Update an offer from the admin dashboard: either a full-form save or an
// { active } toggle. Reached through Next's /api/admin/offers/[id] proxy,
// which verified the admin session; the shared internal secret proves the
// call comes from our own server.
app.patch("/offers/:id", async (req, res) => {
  try {
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret || req.headers["x-internal-secret"] !== secret) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(404).send({ message: "Offer not found." });
    }

    const body = req.body ?? {};
    const update = {};

    for (const key of [
      "title",
      "description",
      "applicableService",
      "couponCode",
      "expiryDate",
      "terms",
    ]) {
      if (typeof body[key] === "string") update[key] = body[key].trim();
    }
    if (body.discountType === "percentage" || body.discountType === "fixed") {
      update.discountType = body.discountType;
    }
    if (body.discountValue !== undefined) {
      const value = Number(body.discountValue);
      if (!Number.isFinite(value) || value <= 0) {
        return res.status(400).send({ message: "Invalid discount value." });
      }
      update.discountValue = value;
    }
    if (body.minBookingAmount !== undefined) {
      const value = Number(body.minBookingAmount);
      update.minBookingAmount = Number.isFinite(value) && value >= 0 ? value : 0;
    }
    // Keep the legacy field names in sync for readers that expect them.
    if (update.couponCode !== undefined) update.promoCode = update.couponCode;
    if (update.applicableService) update.category = update.applicableService;
    if (typeof body.active === "boolean") {
      update.active = body.active;
      update.status = body.active ? "active" : "inactive";
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).send({ message: "Nothing to update." });
    }

    const result = await offersCollection.updateOne(
      { _id: id },
      { $set: update }
    );
    if (!result.matchedCount) {
      return res.status(404).send({ message: "Offer not found." });
    }

    res.status(200).send({ success: true, message: "Offer updated." });
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Failed to update offer" });
  }
});

app.delete("/offers/:id", async (req, res) => {
  try {
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret || req.headers["x-internal-secret"] !== secret) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    let id;
    try {
      id = new ObjectId(req.params.id);
    } catch {
      return res.status(404).send({ message: "Offer not found." });
    }

    const result = await offersCollection.deleteOne({ _id: id });
    if (!result.deletedCount) {
      return res.status(404).send({ message: "Offer not found." });
    }

    res.status(200).send({ success: true, message: "Offer deleted." });
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Failed to delete offer" });
  }
});

app.get("/admin/users", requireAdmin, async (req, res) => {
  try {
    const users = await usersCollection
      .find({ role: { $ne: "admin" } })
      .sort({ createdAt: -1 })
      .toArray();

    const formattedUsers = users.map((user) => ({
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      image: user.image,
      role: user.role,
      isBlocked: user.isBlocked,
      createdAt: user.createdAt,
    }));

    res.status(200).send(formattedUsers);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Failed to fetch users" });
  }
});

app.patch("/admin/users/:id/block", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid user ID" });
    }

    const user = await usersCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!user) {
      return res.status(404).send({ message: "User not found" });
    }

    if (
      user.role === "admin" ||
      user._id.toString() === String(req.user.id)
    ) {
      return res.status(403).send({ message: "Cannot block this user" });
    }

    await usersCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          isBlocked: true,
          updatedAt: new Date(),
        },
      }
    );

    res.status(200).send({ message: "User blocked successfully" });
  } catch (error) {
    res.status(500).send({ message: "Failed to block user" });
  }
});

app.patch("/admin/users/:id/unblock", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid user ID" });
    }

    const result = await usersCollection.updateOne(
      {
        _id: new ObjectId(id),
        role: { $ne: "admin" },
      },
      {
        $set: {
          isBlocked: false,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "User not found" });
    }

    res.status(200).send({ message: "User unblocked successfully" });
  } catch (error) {
    res.status(500).send({ message: "Failed to unblock user" });
  }
});

export default app;