import express from 'express'
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import nodemailer from 'nodemailer';
import 'dotenv/config';

const app=express();
const PORT=8000;

const client = new MongoClient(process.env.MONGODB_URI )

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("SalonBook");

const servicesCollection = database.collection("services");
const appointmentsCollection = database.collection("appointments");
const reportsCollection = database.collection("reports");
const offersCollection = database.collection("offers");
const REPORT_CATEGORIES = [
  "Service Quality",
  "Staff Behaviour",
  "Payment Issue",
  "Booking Issue",
  "Inappropriate Behaviour / Abuse",
  "Other",
];

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
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: `"SalonBook Reports" <${SMTP_USER}>`,
    to: ADMIN_EMAIL,
    subject: `[SalonBook] New issue report: ${report.category} — ${report.subject}`,
    html: buildAdminReportEmail(report),
  });
}

app.use(express.json())
app.use(cors())

app.listen(PORT,()=>{
    console.log('SERVER IS RUNNING GOOD');
})

app.get('/',(req,res)=>{
    res.send({message:'Server is running'})
})

app.get("/services", async (req, res) => {
  try {
    const services = await servicesCollection
      .find({ status: "active" })
      .limit(6)
      .toArray();

    res.status(200).send(services);
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Failed to fetch services" });
  }
});

app.post("/appointments", async (req, res) => {
  try {
    const appointmentData = req.body

    const result = await appointmentsCollection.insertOne({
      ...appointmentData,
      status: "pending",
      createdAt: new Date(),
    })

    res.send({
      success: true,
      insertedId: result.insertedId,
    })
  } catch (error) {
    res.status(500).send({ message: "Failed to book appointment" })
  }
})

app.patch("/appointments/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, paymentStatus } = req.body;

    const update = {};
    if (status) update.status = status;
    if (paymentStatus) update.paymentStatus = paymentStatus;

    if (Object.keys(update).length === 0) {
      return res.status(400).send({ message: "Nothing to update" });
    }

    const result = await appointmentsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: update }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "Appointment not found" });
    }

    res.send({ success: true, modifiedCount: result.modifiedCount });
  } catch (error) {
    console.log(error);
    res.status(500).send({ message: "Failed to update appointment" });
  }
});

app.get("/appointments", async (req, res) => {
  try {
    const result = await appointmentsCollection.find().toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Failed to fetch appointments" });
  }
});

app.post("/reports", async (req, res) => {
  try {
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret || req.headers["x-internal-secret"] !== secret) {
      return res.status(401).send({ message: "Unauthorized" });
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
        return res.status(400).send({ message: `${field} is required.` });
      }
    }

    if (!REPORT_CATEGORIES.includes(category)) {
      return res.status(400).send({ message: "Invalid issue category." });
    }

    if (subject.trim().length > 200) {
      return res
        .status(400)
        .send({ message: "Subject must be 200 characters or fewer." });
    }

    if (description.trim().length > 5000) {
      return res
        .status(400)
        .send({ message: "Description must be 5000 characters or fewer." });
    }

    const report = {
      userId: userId.trim(),
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim(),
      category: category.trim(),
      subject: subject.trim(),
      relatedService:
        typeof relatedService === "string" ? relatedService.trim() : "",
      appointmentId:
        typeof appointmentId === "string" ? appointmentId.trim() : "",
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
    res.status(500).send({ message: "Failed to submit report" });
  }
});