import type { Request, Response } from "express";
import mongoose from "mongoose";
import Notification from "../models/Notification.js";

function controlRoomUserId(req: Request, res: Response): string | null {
  if (req.user?.role !== "CONTROL_ROOM" || !req.user.userId) {
    res.status(403).json({
      success: false,
      message: "Only authorised Control Room staff can access notifications.",
    });
    return null;
  }

  if (!mongoose.isValidObjectId(req.user.userId)) {
    res.status(401).json({ success: false, message: "Invalid user session." });
    return null;
  }

  return req.user.userId;
}

export async function listNotifications(req: Request, res: Response) {
  const userId = controlRoomUserId(req, res);
  if (!userId) return;

  try {
    const rows = await Notification.find({
      dismissedBy: { $nin: [new mongoose.Types.ObjectId(userId)] },
    })
      .sort({ createdAt: -1 })
      .limit(40)
      .lean();

    res.status(200).json({
      success: true,
      notifications: rows.map((item) => ({
        id: item._id.toString(),
        title: item.title,
        message: item.message,
        path: item.path,
        kind: item.kind,
        createdAt: item.createdAt,
        read: item.readBy.some((id) => id.toString() === userId),
      })),
    });
  } catch (error) {
    console.error("List Control Room notifications failed:", error);
    res.status(500).json({
      success: false,
      message: "Unable to load notifications.",
    });
  }
}

export async function markNotificationRead(req: Request, res: Response) {
  const userId = controlRoomUserId(req, res);
  if (!userId) return;

  const notificationId = req.params.notificationId;
  if (!mongoose.isValidObjectId(notificationId)) {
    res.status(400).json({ success: false, message: "Invalid notification ID." });
    return;
  }

  try {
    const result = await Notification.updateOne(
      { _id: notificationId },
      { $addToSet: { readBy: new mongoose.Types.ObjectId(userId) } }
    );

    if (!result.matchedCount) {
      res.status(404).json({ success: false, message: "Notification not found." });
      return;
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Mark notification read failed:", error);
    res.status(500).json({ success: false, message: "Unable to update notification." });
  }
}

export async function markAllNotificationsRead(req: Request, res: Response) {
  const userId = controlRoomUserId(req, res);
  if (!userId) return;

  try {
    await Notification.updateMany(
      { dismissedBy: { $nin: [new mongoose.Types.ObjectId(userId)] } },
      { $addToSet: { readBy: new mongoose.Types.ObjectId(userId) } }
    );
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Mark all notifications read failed:", error);
    res.status(500).json({ success: false, message: "Unable to update notifications." });
  }
}

export async function clearNotifications(req: Request, res: Response) {
  const userId = controlRoomUserId(req, res);
  if (!userId) return;

  try {
    await Notification.updateMany(
      { dismissedBy: { $nin: [new mongoose.Types.ObjectId(userId)] } },
      { $addToSet: { dismissedBy: new mongoose.Types.ObjectId(userId) } }
    );
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Clear notifications failed:", error);
    res.status(500).json({ success: false, message: "Unable to clear notifications." });
  }
}
