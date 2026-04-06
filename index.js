const express = require("express");
const app = express();
const port = process.env.PORT || 3000;
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
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
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
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
    app.get("/users", verifyJWT, async (req, res) => {
      const adminEmail = req.tokenEmail;
      const result = await usersCollection
        .find({ email: { $ne: adminEmail } })
        .toArray();
      res.send(result);
    });

    // admin
    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;

      const result = await usersCollection.findOne({ email });

      res.send(result);
    });

    // admin
    app.patch("/update-role", async (req, res) => {
      const { email, role } = req.body;
      const result = await usersCollection.updateOne(
        { email },
        { $set: { role } },
      );
      res.send(result);
    });

    // admin
    app.patch("/users/fraud/:id", async (req, res) => {
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

      res.send({
        message: isFraud
          ? "Vendor marked as fraud"
          : "Vendor unmarked as fraud",
      });
    });

    // vendor
    app.post("/tickets", async (req, res) => {
      const ticket = req.body;
      const email = ticket.vendorEmail;

      const user = await usersCollection.findOne({ email });
      if (user?.isFraud) {
        return res.status(403).send({
          message: "You are flagged as fraud, cannot add ticket",
        });
      }

      ticket.verificationStatus = "pending";
      ticket.createdAt = new Date().toISOString();

      const result = await ticketsCollection.insertOne(ticket);
      res.send(result);
    });

    // admin
    app.get("/manage-tickets", async (req, res) => {
      const result = await ticketsCollection
        .find({ isHidden: { $ne: true } })
        .sort({
          createdAt: -1,
        })
        .toArray();
      res.send(result);
    });

    // admin
    app.patch("/tickets/status/:id", async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;

      const result = await ticketsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { verificationStatus: status } },
      );

      res.send(result);
    });

    // vendor
    app.get("/tickets/vendor/:email", async (req, res) => {
      const email = req.params.email;

      const result = await ticketsCollection
        .find({ vendorEmail: email })
        .sort({ createdAt: -1 })
        .toArray();

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
        .limit(8)
        .toArray();

      res.send(latestTickets);
    });
    // user
    app.get("/all-tickets", async (req, res) => {
      const query = {
        verificationStatus: "approved",
        isHidden: { $ne: true },
      };

      const allTickets = await ticketsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(allTickets);
    });

    // user
    app.get("/tickets/:id", async (req, res) => {
      const { id } = req.params;
      const ticket = await ticketsCollection.findOne({ _id: new ObjectId(id) });
      res.send(ticket);
    });

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

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
