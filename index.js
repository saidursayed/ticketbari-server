const express = require("express");
const app = express();
const port = process.env.PORT || 3000;
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const admin = require("firebase-admin");
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8",
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middlewares
app.use(
  cors({
    origin: ["http://localhost:5173", "https://ticketbari-app.web.app"],
    credentials: true,
  }),
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  // console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    // console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const db = client.db("ticket-bari");
    const usersCollection = db.collection("users");
    const ticketsCollection = db.collection("tickets");
    const bookingsTicketsCollection = db.collection("bookingsTickets");
    const paymentCollection = db.collection("payments");

    // role middlewares
    const verifyADMIN = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "admin")
        return res
          .status(403)
          .send({ message: "Admin only Actions!", role: user?.role });

      next();
    };

    const verifyVENDOR = async (req, res, next) => {
      const email = req.tokenEmail;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "vendor")
        return res
          .status(403)
          .send({ message: "Vendor only Actions!", role: user?.role });

      next();
    };

    app.post("/user", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date(); //.toISOString()
      user.last_loggedIn = new Date();

      const query = {
        email: user.email,
      };

      const userExists = await usersCollection.findOne(query);
      if (userExists) {
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date(),
          },
        });
        return res.send(result);
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // admin
    app.get("/all-users", verifyJWT, verifyADMIN, async (req, res) => {
      const adminEmail = req.tokenEmail;
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    app.get("/manage-users", verifyJWT, verifyADMIN, async (req, res) => {
      const adminEmail = req.tokenEmail;
      const result = await usersCollection
        .find({ email: { $ne: adminEmail } })
        .toArray();
      res.send(result);
    });

    // user vender admin profile endpoint
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;

      const result = await usersCollection.findOne({ email });

      res.send(result);
    });

    // admin
    app.patch("/update-role", verifyJWT, verifyADMIN, async (req, res) => {
      const { email, role } = req.body;
      const result = await usersCollection.updateOne(
        { email },
        { $set: { role } },
      );
      res.send(result);
    });

    // admin
    app.patch("/users/fraud/:id", verifyJWT, verifyADMIN, async (req, res) => {
      const id = req.params.id;
      const { isFraud } = req.body;
      const user = await usersCollection.findOne({ _id: new ObjectId(id) });

      if (user.role !== "vendor") {
        return res.status(400).send({
          message: "Only vendors can be marked as fraud",
        });
      }

      await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { isFraud } },
      );

      await ticketsCollection.updateMany(
        { vendorEmail: user.email },
        { $set: { isHidden: isFraud } },
      );

      await bookingsTicketsCollection.updateMany(
        { vendorEmail: user.email },
        { $set: { status: "cancelled_by_admin" } },
      );

      res.send({
        message: isFraud
          ? "Vendor marked as fraud"
          : "Vendor unmarked as fraud",
      });
    });

    // vendor
    app.post("/tickets", verifyJWT, verifyVENDOR, async (req, res) => {
      const ticket = req.body;
      const email = ticket.vendorEmail;

      const user = await usersCollection.findOne({ email });
      if (user?.isFraud) {
        return res.status(403).send({
          message: "You are flagged as fraud, cannot add ticket",
        });
      }

      ticket.verificationStatus = "pending";
      ticket.createdAt = new Date();

      const result = await ticketsCollection.insertOne(ticket);
      res.send(result);
    });

    // admin
    app.get("/manage-tickets", verifyJWT, verifyADMIN, async (req, res) => {
      const result = await ticketsCollection
        .find({ isHidden: { $ne: true } })
        .sort({
          createdAt: -1,
        })
        .toArray();
      res.send(result);
    });

    app.get("/tickets/approved", verifyJWT, verifyADMIN, async (req, res) => {
      const result = await ticketsCollection
        .find({ verificationStatus: "approved" })
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    app.patch(
      "/tickets/advertise/:id",
      verifyJWT,
      verifyADMIN,
      async (req, res) => {
        const id = req.params.id;
        const { isAdvertised } = req.body;

        if (isAdvertised === true) {
          const advertisedCount = await ticketsCollection.countDocuments({
            isAdvertised: true,
          });

          if (advertisedCount >= 6) {
            return res.send({
              message: "Maximum 6 tickets can be advertised",
            });
          }
        }

        const result = await ticketsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              isAdvertised,
            },
          },
        );

        res.send({
          success: true,
          message: isAdvertised
            ? "Ticket advertised successfully"
            : "Ticket removed from advertisement",
          result,
        });
      },
    );

    app.get("/advertiseTickets", async (req, res) => {
      const query = { isAdvertised: true };
      const result = await ticketsCollection.find(query).toArray();
      res.send(result);
    });

    // admin
    app.patch(
      "/tickets/status/:id",
      verifyJWT,
      verifyADMIN,
      async (req, res) => {
        const id = req.params.id;
        const { status } = req.body;

        const result = await ticketsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { verificationStatus: status } },
        );

        res.send(result);
      },
    );

    // vendor
    app.get(
      "/tickets/vendor/:email",
      verifyJWT,
      verifyVENDOR,
      async (req, res) => {
        const email = req.params.email;

        const result = await ticketsCollection
          .find({ vendorEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(result);
      },
    );

    // vendor
    app.delete("/ticket/:id", verifyJWT, verifyVENDOR, async (req, res) => {
      const id = req.params.id;
      const result = await ticketsCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // vendor
    app.patch("/ticket/:id", verifyJWT, verifyVENDOR, async (req, res) => {
      const id = req.params.id;
      const ticketData = req.body;
      const result = await ticketsCollection.updateOne(
        {
          _id: new ObjectId(id),
        },
        {
          $set: ticketData,
        },
      );

      res.send(result);
    });

    // user
    app.get("/latest-tickets", async (req, res) => {
      const query = {
        verificationStatus: "approved",
        isHidden: { $ne: true },
      };

      const latestTickets = await ticketsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(9)
        .toArray();

      res.send(latestTickets);
    });

    // user
    app.get("/all-tickets", async (req, res) => {
      const { from, to, type, sort, page = 1, limit = 6 } = req.query;

      const query = {
        verificationStatus: "approved",
        isHidden: { $ne: true },
      };

      if (from) {
        query.from = { $regex: from, $options: "i" };
      }
      if (to) {
        query.to = { $regex: to, $options: "i" };
      }

      if (type) {
        query.transport = type;
      }

      let sortOption = { createdAt: -1 };
      if (sort === "asc") sortOption = { ticketPrice: 1 };
      if (sort === "desc") sortOption = { ticketPrice: -1 };

      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);
      const skip = (pageNum - 1) * limitNum;

      const tickets = await ticketsCollection
        .find(query)
        .sort(sortOption)
        .skip(skip)
        .limit(limitNum)
        .toArray();

      const total = await ticketsCollection.countDocuments(query);

      res.send({
        tickets,
        totalPages: Math.ceil(total / limitNum),
      });
    });

    // user
    app.get("/tickets/:id", async (req, res) => {
      const { id } = req.params;
      const ticket = await ticketsCollection.findOne({ _id: new ObjectId(id) });
      res.send(ticket);
    });

    app.post("/ticket-bookings", verifyJWT, async (req, res) => {
      const bookingData = req.body;
      const { ticketId, quantity } = bookingData;

      const ticket = await ticketsCollection.findOne({
        _id: new ObjectId(ticketId),
      });

      if (!ticket) {
        return res.send({ message: "Ticket not found" });
      }

      if (new Date(ticket.departureDateTime) < new Date()) {
        return res.send({ message: "Ticket expired" });
      }

      if (ticket.ticketQuantity === 0) {
        return res.send({ message: "Ticket not available" });
      }

      if (quantity > ticket.ticketQuantity) {
        return res.send({ message: "Quantity exceeded" });
      }

      const totalPrice = ticket.ticketPrice * quantity;

      const safeBooking = {
        ...bookingData,
        unitPrice: ticket.ticketPrice,
        totalPrice,
        status: "pending",
        createdAt: new Date(),
      };

      const result = await bookingsTicketsCollection.insertOne(safeBooking);

      res.send(result);
    });

    // vendor
    app.get(
      "/bookings/vendor/:email",
      verifyJWT,
      verifyVENDOR,
      async (req, res) => {
        const email = req.params.email;

        const query = { vendorEmail: email };

        const result = await bookingsTicketsCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      },
    );

    // vendor
    app.patch(
      "/bookings/status/:id",
      verifyJWT,
      verifyVENDOR,
      async (req, res) => {
        const { status } = req.body;
        const id = req.params.id;

        const booking = await bookingsTicketsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!booking) {
          return res.send({ message: "Booking not found" });
        }

        if (new Date(booking.departureDateTime) < new Date()) {
          return res.send({ message: "Booking expired" });
        }

        if (booking.status === "cancelled_by_admin") {
          return res.send({ message: "Already cancelled" });
        }

        const result = await bookingsTicketsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status,
            },
          },
        );

        res.send({
          success: true,
          message: `Booking ${status} successfully`,
        });
      },
    );

    // user
    app.get("/bookings/user/:email", verifyJWT, async (req, res) => {
      const email = req.params.email;

      const result = await bookingsTicketsCollection
        .find({ userEmail: email })
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    // user
    app.post("/payment-checkout-session", verifyJWT, async (req, res) => {
      const paymentInfo = req.body;

      const ticket = await ticketsCollection.findOne({
        _id: new ObjectId(paymentInfo.ticketId),
      });

      if (!ticket) {
        return res.send({ message: "Ticket not found" });
      }

      const quantity = Number(paymentInfo.quantity);

      const amount = Math.round(ticket.ticketPrice * 100);
      console.log(quantity, amount);

      if (quantity > ticket.ticketQuantity) {
        return res.send({ message: "Not enough seats" });
      }

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: `Please pay for ${ticket.ticketTitle}`,
                images: [ticket.ticketImage],
              },
              unit_amount: amount,
            },
            quantity,
          },
        ],
        customer_email: paymentInfo.userEmail,
        metadata: {
          quantity: quantity.toString(),
          ticketId: ticket._id.toString(),
          bookingId: paymentInfo.bookingId.toString(),
          ticketTitle: paymentInfo.ticketTitle,
          vendorEmail: paymentInfo.vendorEmail,
        },
        mode: "payment",
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/payment-cancelled`,
      });
      // console.log(session);
      res.send({ url: session.url });
    });

    // user
    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      console.log("session Id ----------->", sessionId);

      if (!sessionId) {
        return res.status(400).send({ message: "Session ID missing" });
      }

      const session = await stripe.checkout.sessions.retrieve(sessionId);
      console.log("Payment  success -------------", session);

      const paymentTicket = await paymentCollection.findOne({
        transactionId: session.payment_intent,
      });

      if (paymentTicket) {
        return res.send({ message: "already exist" });
      }

      if (session.payment_status === "paid") {
        const ticketId = session.metadata.ticketId;

        const query = {
          _id: new ObjectId(session.metadata.bookingId),
        };
        const update = {
          $set: {
            status: "paid",
          },
        };

        const result = await bookingsTicketsCollection.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          ticketId: ticketId,
          bookingId: session.metadata.bookingId,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          quantity: session.metadata.quantity,
          ticketTitle: session.metadata.ticketTitle,
          vendorEmail: session.metadata.vendorEmail,
          paidAt: new Date(),
        };

        const resultPayment = await paymentCollection.insertOne(payment);

        const qty = Number(session.metadata.quantity);
        await ticketsCollection.updateOne(
          {
            _id: new ObjectId(ticketId),
          },
          { $inc: { ticketQuantity: -qty } },
        );

        return res.send({
          success: true,
          modifyTicket: result,
          paymentInfo: resultPayment,
          transactionId: session.payment_intent,
          amount: session.amount_total / 100,
        });
      }
    });

    // user
    app.get("/payments", verifyJWT, async (req, res) => {
      const email = req.query.email;
      const query = { customerEmail: email };
      const result = await paymentCollection
        .find(query)
        .sort({ paidAt: -1 })
        .toArray();
      res.send(result);
    });

    // vendor
    app.get(
      "/vendor/revenue-overview",
      verifyJWT,
      verifyVENDOR,
      async (req, res) => {
        const email = req.query.email;

        const payments = await paymentCollection
          .find({ vendorEmail: email })
          .toArray();

        // payment revenue
        const totalRevenue = payments.reduce(
          (sum, item) => sum + (item.amount || 0),
          0,
        );
        // tickets sold
        const totalTicketsSold = payments.reduce(
          (sum, item) => sum + Number(item.quantity),
          0,
        );

        // Tickets added (approved)
        const totalTicketsAdded = await ticketsCollection.countDocuments({
          vendorEmail: email,
          verificationStatus: "approved",
        });

        res.send({ totalRevenue, totalTicketsSold, totalTicketsAdded });
      },
    );

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

module.exports = app;
