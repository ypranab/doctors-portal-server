const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const port = process.env.PORT || 5000;
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();
const stripe = require("stripe")(process.env.STRIPE_KEY);

app.use(express.json())
app.use(cors())

app.get('/', async (req, res) => {
    res.send('Doctors portal Server is running')
})

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.nslo89v.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

function verifyJWT(req, res, next) {
    //console.log(req.headers.authorization)
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send('unauthorized')
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN, function (error, decoded) {
        if (error) {
            res.status(403).send({ message: 'forbidden access' })
        }
        req.decoded = decoded;
        next();
    })
}

async function run() {
    try {
        const appointmentOptionsCollection = client.db('doctorsPortalDB').collection('appointmentOptions');
        const bookingCollection = client.db('doctorsPortalDB').collection('bookings');
        const usersCollection = client.db('doctorsPortalDB').collection('users');
        const doctorsCollection = client.db('doctorsPortalDB').collection('doctors');

        // NOTE: make sure you use verifyAdmin after verifyJWT
        const verifyAdmin = async (req, res, next) => {
            const decodedEmail = req.decoded.email;
            const query = { email: decodedEmail };
            const user = await usersCollection.findOne(query);

            if (user?.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' })
            }
            next();
        }

        app.get('/jwt', async (req, res) => {
            const email = req.query.email;
            const query = { email: email }
            const registeredUser = await usersCollection.findOne(query);
            if (registeredUser) {
                const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: '1h' })
                return res.send({ accessToken: token })
            }
            //console.log(registeredUser)
            res.send({ accessToken: 'unathorized' })
        })

        app.post("/create-payment-intent", async (req, res) => {
            const booking = req.body;
            const price = booking.price;
            const amount = price * 100;
            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: "usd",
                "payment_method_types": [
                    "card"
                ],
            });

            res.send({
                clientSecret: paymentIntent.client_secret,
            });
        });

        app.get('/appointmentOptions', async (req, res) => {
            const date = req.query.date;
            const query = {};
            const cursor = appointmentOptionsCollection.find(query);
            const options = await cursor.toArray();
            const bookingQuery = { appointmentDate: date }
            const alreadyBooked = await bookingCollection.find(bookingQuery).toArray();

            options.forEach(option => {
                const optionBooked = alreadyBooked.filter(book => book.treatment === option.name)
                const bookedSlots = optionBooked.map(booked => booked.slot)
                const remainingSlots = option.slots.filter(slot => !bookedSlots.includes(slot))
                option.slots = remainingSlots;
                //console.log(date, option.name, remainingSlots.length)
            })
            res.send(options);
        })

        app.get('/users', async (req, res) => {
            const query = {};
            const users = await usersCollection.find(query).toArray();
            res.send(users)
        })

        app.get('/bookings', verifyJWT, async (req, res) => {
            const email = req.query.email;
            const query = { email: email }
            const decodedEmail = req.decoded.email;
            //console.log(decodedEmail)
            if (email !== decodedEmail) {
                res.status(403).send({ message: 'forbidden' })
            }
            const bookings = await bookingCollection.find(query).toArray();
            res.send(bookings);
        })

        app.get('/appoinmentSpecialty', async (req, res) => {
            const query = {}
            const result = await appointmentOptionsCollection.find(query).project({ name: 1 }).toArray();
            res.send(result)
        })

        app.post('/bookings', async (req, res) => {
            const booking = req.body;
            const query = {
                appointmentDate: booking.appointmentDate,
                email: booking.email,
                treatment: booking.treatment
            }
            const dateBooked = await bookingCollection.find(query).toArray();
            //console.log(booking)
            if (dateBooked.length) {
                const message = `You already booked ${booking.appointmentDate}`
                return res.send({ acknowledged: false, message })
            }
            const result = await bookingCollection.insertOne(booking);
            res.send(result)
        })

        app.post('/users', async (req, res) => {
            const user = req.body
            const result = await usersCollection.insertOne(user);
            res.send(result)
        })

        app.get('/users/admin/:email', async (req, res) => {
            const email = req.params.email;
            const query = { email: email };
            const user = await usersCollection.findOne(query);
            if (user?.role === 'admin') {
                res.send({ isAdmin: true })
            }
            else {
                res.send({ isAdmin: false })
            }
        })

        app.put('/users/admin:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: ObjectId(id) }
            const options = { upsert: true }
            const updatedDoc = { $set: { role: 'admin' } }
            const result = await usersCollection.updateOne(filter, updatedDoc, options);
            res.send(result)
        })

        app.get('/bookings/:id', async (req, res) => {
            const id = req.params.id
            const query = { _id: ObjectId(id) }
            const result = await bookingCollection.findOne(query);
            res.send(result)
        })

        app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const query = {};
            const doctors = await doctorsCollection.find(query).toArray();
            res.send(doctors);
        })

        app.post('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const doctor = req.body;
            const result = await doctorsCollection.insertOne(doctor);
            res.send(result)
        })

        app.delete('/doctors/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id
            const filter = { _id: ObjectId(id) }
            const result = await doctorsCollection.deleteOne(filter)
            res.send(result)
        })

        // temporary to update price field on appointment options
        // app.get('/addPrice', async (req, res) => {
        //     const query = {}
        //     const options = { upsert: true }
        //     const updatedDoc = { $set: { price: 99 } }
        //     const result = await appointmentOptionsCollection.updateMany(query, updatedDoc, options)
        //     res.send(result);
        // })

    }
    finally {

    }
}

run().catch();

app.listen(port, () => {
    console.log(`Doctors portal in running on ${port}`)
})