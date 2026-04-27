const DEFAULT_PUSH_SOUND = "default";
const CUSTOM_PUSH_SOUND = "custom_sound";

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
      notification: {
        sound: normalizedSound,
        channelId: "channel_id",
      },
    },
    apns: {
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
};
