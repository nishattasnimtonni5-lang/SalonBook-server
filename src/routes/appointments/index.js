import { Router } from "express";
import { stripe } from "../../app/config/stripe.js";
import {
  appointmentCollection,
  servicesCollection,
} from "../../app/config/db.js";
import { ObjectId } from "mongodb";

const router = Router();

router.post("/create-checkout-session", async (req, res) => {
  try {
    const payload = req.body;

    const service = await servicesCollection.findOne({
      _id: new ObjectId(payload.serviceId),
    });

    if (!service) {
      return res.status(404).send({ message: "Service not found" });
    }

    const appointment = {
      serviceId: payload.serviceId,
      serviceName: service.name,
      serviceImage: service.image,
      price: service.price,
      duration: service.duration,
      userId: req.user.id,
      customerEmail: payload.customerEmail,
      date: payload.date,
      time: payload.time,
      status: "pending",
      paymentStatus: "unpaid",
      createdAt: new Date(),
    };

    const appointmentResult = await appointmentCollection.insertOne(appointment);
console.log("BEFORE STRIPE SESSION");
    const session = await stripe.checkout.sessions.create({
      line_items: [        {
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
      success_url: `${process.env.CLIENT_URL}/appointment/success?appointmentId=${appointmentResult.insertedId}`,
      cancel_url: `${process.env.CLIENT_URL}/appointment/cancel`,
      mode: "payment",
      metadata: {
        appointmentId: appointmentResult.insertedId.toString(),
        userId: req.user.id,
      },
    });

console.log("CREATED CHECKOUT SESSION:", session.id);
console.log("CREATED SESSION METADATA:", session.metadata);
    res.send({
      success: true,
      message: "Checkout session created",
      data: { redirectUrl: session.url },
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to create checkout session" });
  }
});
export default router