const express = require("express");
const app = express();
const port = process.env.PORT || 3000;
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
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
