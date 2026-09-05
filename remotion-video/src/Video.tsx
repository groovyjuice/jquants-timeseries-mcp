import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/700.css';
import '@fontsource/noto-sans-jp/800.css';
import React from 'react';
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import {scenes as defaultScenes, type Scene} from './scenes';

export type VideoProps = {
  scenes?: Scene[];
};

const avatarAssets = {
  normalBase: staticFile('character/normal_base.png'),
  seriousBase: staticFile('character/serious_base.png'),
  eyesOpen: staticFile('character/eyes_open.png'),
  eyesBlink: staticFile('character/eyes_blink.png'),
  eyesSurprise: staticFile('character/eyes_surprise.png'),
  mouthClosed: staticFile('character/mouth_closed.png'),
  mouthHalf: staticFile('character/mouth_half.png'),
  mouthOpen: staticFile('character/mouth_open.png'),
};

const AvatarLayer: React.FC<{src: string}> = ({src}) => (
  <Img
    src={src}
    style={{
      position: 'absolute',
      inset: 0,
      width: '100%',
      height: '100%',
      objectFit: 'contain',
    }}
  />
);

const Avatar: React.FC<{emotion: Scene['emotion']}> = ({emotion}) => {
  const frame = useCurrentFrame();

  // Deterministic, subtle body motion.
  const bob = Math.sin(frame / 11) * 4;

  // One short blink about every 4 seconds.
  const blinkPhase = frame % 120;
  const isBlinking = blinkPhase >= 114 && blinkPhase <= 118;

  // Simple 3-state mouth cycle: closed -> half -> open -> half.
  const mouthPhase = frame % 12;
  const mouthSrc =
    mouthPhase < 3
      ? avatarAssets.mouthClosed
      : mouthPhase < 6
        ? avatarAssets.mouthHalf
        : mouthPhase < 9
          ? avatarAssets.mouthOpen
          : avatarAssets.mouthHalf;

  const baseSrc =
    emotion === 'serious'
      ? avatarAssets.seriousBase
      : avatarAssets.normalBase;

  const eyesSrc =
    emotion === 'surprise'
      ? avatarAssets.eyesSurprise
      : isBlinking
        ? avatarAssets.eyesBlink
        : avatarAssets.eyesOpen;

  return (
    <div
      style={{
        position: 'absolute',
        right: 48,
        bottom: 108,
        width: 500,
        height: 500,
        transform: `translateY(${bob}px)`,
        filter: 'drop-shadow(0 18px 28px rgba(0,0,0,0.28))',
      }}
    >
      <AvatarLayer src={baseSrc} />
      <AvatarLayer src={eyesSrc} />
      <AvatarLayer src={mouthSrc} />
    </div>
  );
};

const SceneCard: React.FC<{
  title: string;
  body: string;
  emotion: Scene['emotion'];
}> = ({title, body, emotion}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(135deg, #101624 0%, #24324d 100%)',
        color: 'white',
        fontFamily: "'Noto Sans JP', sans-serif",
        padding: 120,
      }}
    >
      <div style={{opacity, maxWidth: 1160}}>
        <div style={{fontSize: 94, fontWeight: 800, lineHeight: 1.1}}>{title}</div>
        <div style={{fontSize: 50, marginTop: 48, lineHeight: 1.5}}>{body}</div>
      </div>

      <Avatar emotion={emotion} />

      <div
        style={{
          position: 'absolute',
          left: 120,
          right: 120,
          bottom: 55,
          fontSize: 34,
          padding: '20px 30px',
          borderRadius: 20,
          background: 'rgba(0,0,0,0.55)',
          textAlign: 'center',
          zIndex: 20,
        }}
      >
        {body}
      </div>
    </AbsoluteFill>
  );
};

export const TestVideo: React.FC<VideoProps> = ({scenes = defaultScenes}) => {
  return (
    <AbsoluteFill>
      {scenes.map((scene, i) => (
        <Sequence key={i} from={scene.from} durationInFrames={scene.duration}>
          <SceneCard
            title={scene.title}
            body={scene.body}
            emotion={scene.emotion}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
