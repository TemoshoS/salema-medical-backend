import { Router, Request, Response } from "express";
import { authenticateToken } from "../middleware/authMiddleware.js";
import { placesSearchLimiter } from "../middleware/rateLimiters.js";

const router = Router();

router.use(authenticateToken);
router.use(placesSearchLimiter);

const GOOGLE_PLACES_URL = "https://places.googleapis.com/v1";

router.post("/autocomplete", async (req: Request, res: Response) => {
  const input =
    typeof req.body?.input === "string" ? req.body.input.trim() : "";

  if (input.length < 3) {
    return res.json({ success: true, suggestions: [] });
  }

  if (input.length > 200) {
    return res.status(400).json({
      success: false,
      message: "Search text is too long.",
    });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      success: false,
      message: "Address search is not configured.",
    });
  }

  try {
    const googleResponse = await fetch(
      `${GOOGLE_PLACES_URL}/places:autocomplete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask":
            "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat.mainText.text,suggestions.placePrediction.structuredFormat.secondaryText.text",
        },
        body: JSON.stringify({
          input,
          includedRegionCodes: ["za"],
          languageCode: "en",
        }),
        signal: AbortSignal.timeout(8000),
      },
    );

    if (!googleResponse.ok) {
      const googleError = await googleResponse.text();
      console.error(
        "Google Places autocomplete returned status:",
        googleResponse.status,
        "Google error:",
        googleError,
      );

      return res.status(502).json({
        success: false,
        message: "Address suggestions are temporarily unavailable.",
      });
    }

    const data = (await googleResponse.json()) as {
      suggestions?: Array<{
        placePrediction?: {
          placeId?: string;
          text?: { text?: string };
          structuredFormat?: {
            mainText?: { text?: string };
            secondaryText?: { text?: string };
          };
        };
      }>;
    };

    const suggestions = (data.suggestions ?? [])
      .flatMap((item) => {
        const place = item.placePrediction;

        if (!place?.placeId || !place.text?.text) {
          return [];
        }

        return [{
          placeId: place.placeId,
          description: place.text.text,
          mainText:
            place.structuredFormat?.mainText?.text ??
            place.text.text,
          secondaryText:
            place.structuredFormat?.secondaryText?.text ?? "",
        }];
      })
      .slice(0, 6);

    return res.json({ success: true, suggestions });
  } catch (error) {
    console.error("Google Places autocomplete failed:", error);

    return res.status(502).json({
      success: false,
      message: "Unable to search addresses right now.",
    });
  }
});


router.get("/directions", async (req: Request, res: Response) => {
  const parseCoordinate = (value: unknown): number | null => {
    if (typeof value !== "string" || value.trim() === "") {
      return null;
    }

    const number = Number(value);

    return Number.isFinite(number) ? number : null;
  };

  const originLat = parseCoordinate(req.query.originLat);
  const originLng = parseCoordinate(req.query.originLng);
  const destinationLat = parseCoordinate(req.query.destinationLat);
  const destinationLng = parseCoordinate(req.query.destinationLng);

  const validCoordinates =
    originLat !== null &&
    originLng !== null &&
    destinationLat !== null &&
    destinationLng !== null &&
    originLat >= -90 &&
    originLat <= 90 &&
    destinationLat >= -90 &&
    destinationLat <= 90 &&
    originLng >= -180 &&
    originLng <= 180 &&
    destinationLng >= -180 &&
    destinationLng <= 180;

  if (!validCoordinates) {
    return res.status(400).json({
      success: false,
      message: "Valid origin and destination coordinates are required.",
    });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      success: false,
      message: "Driving directions are not configured.",
    });
  }

  try {
    const params = new URLSearchParams({
      origin: `${originLat},${originLng}`,
      destination: `${destinationLat},${destinationLng}`,
      mode: "driving",
      key: apiKey,
    });

    const googleResponse = await fetch(
      `https://maps.googleapis.com/maps/api/directions/json?${params}`,
      { signal: AbortSignal.timeout(10000) },
    );

    if (!googleResponse.ok) {
      console.error(
        "Google Directions HTTP status:",
        googleResponse.status,
      );

      return res.status(502).json({
        success: false,
        message: "Driving directions are temporarily unavailable.",
      });
    }

    const data = (await googleResponse.json()) as {
      status?: string;
      error_message?: string;
      routes?: Array<{
        overview_polyline?: { points?: string };
        legs?: Array<{
          distance?: { value?: number; text?: string };
          duration?: { value?: number; text?: string };
        }>;
      }>;
    };

    const route = data.routes?.[0];
    const leg = route?.legs?.[0];
    const encodedPolyline = route?.overview_polyline?.points;

    if (
      data.status !== "OK" ||
      !encodedPolyline ||
      !leg?.distance ||
      !leg.duration
    ) {
      console.warn("Google Directions returned no usable route:", {
        status: data.status,
        message: data.error_message,
      });

      return res.status(404).json({
        success: false,
        message: "No driving route is currently available.",
      });
    }

    return res.json({
      success: true,
      route: {
        encodedPolyline,
        distanceMeters: leg.distance.value,
        distanceText: leg.distance.text,
        duration: `${leg.duration.value}s`,
        durationSeconds: leg.duration.value,
        durationText: leg.duration.text,
      },
    });
  } catch (error) {
    console.error("Google Directions request failed:", error);

    return res.status(502).json({
      success: false,
      message: "Unable to retrieve driving directions right now.",
    });
  }
});


router.get("/details/:placeId", async (req: Request, res: Response) => {
  const placeId = req.params.placeId;

  if (
    typeof placeId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(placeId)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid place identifier.",
    });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      success: false,
      message: "Address search is not configured.",
    });
  }

  try {
    const googleResponse = await fetch(
      `${GOOGLE_PLACES_URL}/places/${encodeURIComponent(placeId)}`,
      {
        headers: {
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "id,formattedAddress,location",
        },
        signal: AbortSignal.timeout(8000),
      },
    );

    if (!googleResponse.ok) {
      console.error(
        "Google Places details returned status:",
        googleResponse.status,
      );

      return res.status(502).json({
        success: false,
        message: "Unable to retrieve the selected address.",
      });
    }

    const place = (await googleResponse.json()) as {
      id?: string;
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
    };

    const latitude = place.location?.latitude;
    const longitude = place.location?.longitude;

    if (
      typeof latitude !== "number" ||
      typeof longitude !== "number" ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      return res.status(502).json({
        success: false,
        message: "Coordinates are unavailable for this address.",
      });
    }

    return res.json({
      success: true,
      place: {
        placeId: place.id ?? placeId,
        address: place.formattedAddress ?? "",
        location: { latitude, longitude },
      },
    });
  } catch (error) {
    console.error("Google Places details failed:", error);

    return res.status(502).json({
      success: false,
      message: "Unable to retrieve the selected address.",
    });
  }
});

export default router;
