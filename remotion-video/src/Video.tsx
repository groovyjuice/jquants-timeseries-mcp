import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/700.css';
import '@fontsource/noto-sans-jp/800.css';
import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import {
  scenes as defaultScenes,
  type MouthState,
  type Scene,
} from './scenes';

export type VideoProps = {
  scenes?: Scene[];
};

const avatarAssets = {
  normalBase: staticFile('character/normal_base.png'),
  seriousBase: staticFile('character/serious_base.png'),
  surpriseBase: staticFile('character/surprise_base.png'),
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

const Avatar: React.FC<{
  emotion: Scene['emotion'];
  mouthCues?: MouthState[];
}> = ({emotion, mouthCues}) => {
  const frame = useCurrentFrame();

  const bob = Math.sin(frame / 11) * 4;

  const isSmile = emotion === 'smile';
  const blinkPhase = frame % 120;
  const isBlinking = !isSmile && blinkPhase >= 114 && blinkPhase <= 118;

  const mouthPhase = frame % 12;
  const fallbackMouthState: MouthState =
    mouthPhase < 3 ? 0 : mouthPhase < 6 ? 1 : mouthPhase < 9 ? 2 : 1;

  const mouthState: MouthState = mouthCues
    ? (mouthCues[frame] ?? 0)
    : fallbackMouthState;

  const mouthSrc =
    mouthState === 0
      ? avatarAssets.mouthClosed
      : mouthState === 1
        ? avatarAssets.mouthHalf
        : avatarAssets.mouthOpen;

  const baseSrc =
    emotion === 'serious'
      ? avatarAssets.seriousBase
      : emotion === 'surprise'
        ? avatarAssets.surpriseBase
        : avatarAssets.normalBase;

  const eyesSrc =
    isSmile
      ? avatarAssets.eyesBlink
      : isBlinking
        ? avatarAssets.eyesBlink
        : emotion === 'surprise'
          ? avatarAssets.eyesSurprise
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

const SceneCard: React.FC<{scene: Scene}> = ({scene}) => {
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
      {scene.audioSrc ? <Audio src={staticFile(scene.audioSrc)} /> : null}

      <div style={{opacity, maxWidth: 1160}}>
        <div style={{fontSize: 94, fontWeight: 800, lineHeight: 1.1}}>
          {scene.title}
        </div>
        <div style={{fontSize: 50, marginTop: 48, lineHeight: 1.5}}>
          {scene.body}
        </div>
      </div>

      <Avatar emotion={scene.emotion} mouthCues={scene.mouthCues} />

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
        {scene.narration ?? scene.body}
      </div>
    </AbsoluteFill>
  );
};

export const TestVideo: React.FC<VideoProps> = ({scenes = defaultScenes}) => {
  return (
    <AbsoluteFill>
      {scenes.map((scene, i) => (
        <Sequence key={i} from={scene.from} durationInFrames={scene.duration}>
          <SceneCard scene={scene} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
