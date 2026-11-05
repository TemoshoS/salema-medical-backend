
import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createServer } from "node:http";
import { connectDatabase } from "./config/database.js";
import medicalRequestRoutes from "./routes/medicalRequestRoutes.js";
import callbackRequestRoutes from "./routes/callbackRequestRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import placesRoutes from "./routes/placesRoutes.js";
import callSessionRoutes from "./routes/callSessionRoutes.js";
import providerRoutes from "./routes/providerRoutes.js";
import { initializeMedicalTrackingSocket } from "./services/medicalTrackingSocket.js";

const app = express();

app.use((req, res, next) => {
  const start = Date.now();

  res.on("finish", () => {
    console.log(
      `${req.method} ${req.originalUrl} ${res.statusCode} - ${Date.now() - start}ms`
    );
  });

  next();
});

const httpServer = createServer(app);
const allowedOrigin =
  process.env.CLIENT_ORIGIN || "http://localhost:8081";

const allowedOrigins = [
  allowedOrigin,
  "http://localhost:5173",
];

initializeMedicalTrackingSocket(httpServer, allowedOrigin);

app.use(helmet());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked origin: ${origin}`));
      }
    },
  })
);

app.use(express.json({ limit: "1mb" }));

app.use("/api/medical-requests", medicalRequestRoutes);
app.use("/api/callback-requests", callbackRequestRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/places", placesRoutes);
app.use("/api/call-sessions", callSessionRoutes);
app.use("/api/providers", providerRoutes);

app.get("/api/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "Salema Medical API is running",
    timestamp: new Date().toISOString(),
  });
});

const PORT = Number(process.env.PORT) || 5000;

async function startServer(): Promise<void> {
  try {
    await connectDatabase();

    httpServer.listen(PORT, "0.0.0.0", () => {
      console.log(`Salema Medical API running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start Salema Medical API:", error);
    process.exit(1);
  }
}

void startServer();
