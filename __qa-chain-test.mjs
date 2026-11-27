import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const CLIENT = "http://localhost:3000";
const BACKEND = "https://salon-book-server-six.vercel.app";
const ts = Date.now();
const email = `qa-manage-fix-${ts}@example.com`;
const password = "QaTestPass123!";

const results = [];
const log = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} | ${name} | ${detail}`);
};

async function j(method, url, { body, headers } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      // BetterAuth rejects POSTs without an Origin; mirror the browser.
      Origin: CLIENT,
      ...(headers || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

const summarize = (data) =>
  Array.isArray(data) ? `array(len=${data.length})` : JSON.stringify(data)?.slice(0, 140);

// --- 1. QA admin account -------------------------------------------------
let r = await j("POST", `${BACKEND}/api/auth/sign-up/email`, {
  body: { name: "QA Manage", email, password },
});
log("signup", r.status === 200 || r.status === 201, `status=${r.status}`);
const userId = r.data?.user?.id;
if (!userId) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(1);
}

const mongo = new MongoClient(process.env.MONGODB_URI);
await mongo.connect();
const db = mongo.db("SalonBook");
await db
  .collection("user")
  .updateOne({ _id: new ObjectId(userId) }, { $set: { role: "admin" } });

r = await j("POST", `${BACKEND}/api/auth/sign-in/email`, {
  body: { email, password },
});
log("signin", r.status === 200 && !!r.data?.token, `status=${r.status}`);
const token = r.data?.token;
if (!token) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(1);
}
const cookie = { Cookie: `sb_session_token=${encodeURIComponent(token)}` };

// --- 2. Admin appointments list (was 401 "must be signed in") ------------
r = await j("GET", `${CLIENT}/api/admin/appointments`, { headers: cookie });
const appts = Array.isArray(r.data) ? r.data : [];
log(
  "admin appointments GET",
  r.status === 200 && Array.isArray(r.data),
  `status=${r.status} ${summarize(r.data)}`,
);

// --- 3. Appointment status PATCH via forwarded signed cookie -------------
// Re-applying the current status is an explicit no-op server-side, so this
// exercises the whole chain without mutating anything.
const patchable = appts.find(
  (a) =>
    typeof a.status === "string" &&
    ["pending", "confirmed", "cancelled"].includes(a.status),
);
if (patchable) {
  const p = await j(
    "PATCH",
    `${CLIENT}/api/admin/appointments/${patchable._id}`,
    { headers: cookie, body: { status: patchable.status } },
  );
  log(
    "appointments PATCH (same status, signed cookie)",
    p.status === 200,
    `status=${p.status} ${summarize(p.data)}`,
  );
} else {
  log("appointments PATCH (same status, signed cookie)", false, "no patchable appointment found");
}

// --- 4. Admin reports list (was 401) -------------------------------------
r = await j("GET", `${CLIENT}/api/admin/reports`, { headers: cookie });
const reports = Array.isArray(r.data) ? r.data : [];
log(
  "admin reports GET",
  r.status === 200 && Array.isArray(r.data),
  `status=${r.status} ${summarize(r.data)}`,
);

// --- 5. Report status PATCH (no-op: lowercase -> same Title-case) ---------
const TitleCase = { pending: "Pending", reviewed: "Reviewed", resolved: "Resolved" };
const patchReport = reports.find((rep) => {
  const lower = String(rep.status || "").toLowerCase();
  return TitleCase[lower] === rep.status;
});
if (patchReport) {
  const lower = String(patchReport.status).toLowerCase();
  const p = await j(
    "PATCH",
    `${CLIENT}/api/admin/reports/${patchReport._id}`,
    { headers: cookie, body: { status: lower } },
  );
  log(
    "reports PATCH (same status)",
    p.status === 200,
    `status=${p.status} ${summarize(p.data)}`,
  );
} else {
  log("reports PATCH (same status)", false, "no Title-case report found");
}

// --- 6. Admin offers list (GET /offers/all was 404) ----------------------
r = await j("GET", `${CLIENT}/api/admin/offers`, { headers: cookie });
log(
  "admin offers GET",
  r.status === 200 && Array.isArray(r.data),
  `status=${r.status} ${summarize(r.data)}`,
);

// --- 7. Create QA offer ---------------------------------------------------
r = await j("POST", `${CLIENT}/api/admin/offers`, {
  headers: cookie,
  body: {
    title: "QA Test Offer",
    description: "Temporary offer created by the automated verification.",
    discountType: "percentage",
    discountValue: "10",
    applicableService: "Hair Cut",
    couponCode: "QATEST",
    expiryDate: "2027-01-01",
    minBookingAmount: "",
    terms: "Created and removed by the QA test.",
  },
});
const offerId = r.data?.insertedId;
log("offer POST (create)", r.status === 201 && !!offerId, `status=${r.status} ${summarize(r.data)}`);

if (offerId) {
  r = await j("GET", `${CLIENT}/api/admin/offers`, { headers: cookie });
  const listed = Array.isArray(r.data) && r.data.some((o) => o._id === offerId);
  log("offer visible in admin list", listed, `status=${r.status}`);

  const t1 = await j("PATCH", `${CLIENT}/api/admin/offers/${offerId}`, {
    headers: cookie,
    body: { active: false },
  });
  const t2 = await j("PATCH", `${CLIENT}/api/admin/offers/${offerId}`, {
    headers: cookie,
    body: { active: true },
  });
  log(
    "offer PATCH toggle (active false/true)",
    t1.status === 200 && t2.status === 200,
    `false=${t1.status} true=${t2.status}`,
  );

  const full = await j("PATCH", `${CLIENT}/api/admin/offers/${offerId}`, {
    headers: cookie,
    body: {
      title: "QA Test Offer",
      description: "Temporary offer created by the automated verification.",
      discountType: "percentage",
      discountValue: "15",
      applicableService: "Hair Cut",
      couponCode: "QATEST",
      expiryDate: "2027-01-01",
      minBookingAmount: "0",
      terms: "Created and removed by the QA test.",
    },
  });
  log("offer PATCH (full form)", full.status === 200, `status=${full.status} ${summarize(full.data)}`);

  const del = await j("DELETE", `${CLIENT}/api/admin/offers/${offerId}`, {
    headers: cookie,
  });
  log("offer DELETE", del.status === 200, `status=${del.status} ${summarize(del.data)}`);
}

// --- 8. Signed-out guard: no cookie -> 401 (as before, but now only here) --
const anon = await j("GET", `${CLIENT}/api/admin/reports`);
log(
  "anonymous admin reports GET still 401",
  anon.status === 401,
  `status=${anon.status}`,
);

// --- 9. Keep the QA account for the browser pass; cleanup happens later ---
await mongo.close();

const failed = results.filter((x) => !x.ok);
console.log(`\nQA-EMAIL=${email}`);
console.log(`SUMMARY=${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
