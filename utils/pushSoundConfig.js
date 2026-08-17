const DEFAULT_PUSH_SOUND = "default";
const CUSTOM_PUSH_SOUND = "custom_sound";
const DRIVER_NOTIFICATION_CHANNEL =
  process.env.DRIVER_NOTIFICATION_CHANNEL || "delivery_alerts_v4";

const normalizePushSound = (soundType = DEFAULT_PUSH_SOUND) =>
  soundType === DEFAULT_PUSH_SOUND ? DEFAULT_PUSH_SOUND : CUSTOM_PUSH_SOUND;

const buildPlatformPushConfig = (
  title,
  body,
  soundType = DEFAULT_PUSH_SOUND,
) => {
  const normalizedSound = normalizePushSound(soundType);

  return {
    android: {
      priority: "high",
      notification: {
        sound: normalizedSound,
        channelId: DRIVER_NOTIFICATION_CHANNEL,
      },
    },
    apns: {
      headers: {
        "apns-priority": "10", // ← CRITICAL for iOS
      },

      payload: {
        aps: {
          alert: { title, body },
          sound:
            normalizedSound === DEFAULT_PUSH_SOUND
              ? DEFAULT_PUSH_SOUND
              : `${CUSTOM_PUSH_SOUND}.wav`,
        },
      },
    },
  };
};

module.exports = {
  DEFAULT_PUSH_SOUND,
  CUSTOM_PUSH_SOUND,
  normalizePushSound,
  buildPlatformPushConfig,
  DRIVER_NOTIFICATION_CHANNEL,
};
