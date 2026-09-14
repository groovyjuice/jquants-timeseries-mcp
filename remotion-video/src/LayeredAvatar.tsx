import React from 'react';
import {Img, staticFile, useCurrentFrame} from 'remotion';
import type {MouthState} from './scenes';

export type CharacterPose =
  | 'normal'
  | 'point_up'
  | 'caution'
  | 'positive'
  | 'explain';

export type CharacterExpression =
  | 'normal'
  | 'serious'
  | 'surprise'
  | 'smile';

export type LayeredAvatarProps = {
  pose?: CharacterPose;
  emotion?: CharacterExpression;
  mouthCues?: MouthState[];
  size?: number;
  bobAmount?: number;
  enableBlink?: boolean;
  showShadow?: boolean;
};

const assets = {
  body: {
    normal: staticFile('characters/body_normal.png'),
    point_up: staticFile('characters/body_point_up.png'),
    caution: staticFile('characters/body_caution.png'),
    positive: staticFile('characters/body_positive.png'),
    explain: staticFile('characters/body_explain.png'),
  },
  headBase: staticFile('characters/head_base.png'),
  hairBack: staticFile('characters/hair_back.png'),
  hairFront: staticFile('characters/hair_front.png'),
  eyebrow: {
    normal: staticFile('characters/eyebrow_normal.png'),
    serious: staticFile('characters/eyebrow_serious.png'),
    surprise: staticFile('characters/eyebrow_surprise.png'),
    smile: staticFile('characters/eyebrow_smile.png'),
  },
  eyes: {
    open: staticFile('characters/eyes_open.png'),
    closed: staticFile('characters/eyes_closed.png'),
    surprise: staticFile('characters/eyes_surprise.png'),
    smile: staticFile('characters/eyes_smile.png'),
  },
  pupilLeft: staticFile('characters/pupil_left.png'),
  pupilRight: staticFile('characters/pupil_right.png'),
  mouth: {
    closed: staticFile('characters/mouth_closed.png'),
    half: staticFile('characters/mouth_half.png'),
    open: staticFile('characters/mouth_open.png'),
    smileClosed: staticFile('characters/mouth_smile_closed.png'),
    smileOpen: staticFile('characters/mouth_smile_open.png'),
  },
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
      pointerEvents: 'none',
    }}
  />
);

const fallbackMouthStateAtFrame = (frame: number): MouthState => {
  const phase = frame % 30;
  if (phase < 10) return 0;
  if (phase < 20) return 1;
  return 2;
};

export const LayeredAvatar: React.FC<LayeredAvatarProps> = ({
  pose = 'normal',
  emotion = 'normal',
  mouthCues,
  size = 460,
  bobAmount = 3,
  enableBlink = true,
  showShadow = true,
}) => {
  const frame = useCurrentFrame();
  const bob = Math.sin((frame / 120) * Math.PI * 2) * bobAmount;

  const blinkPhase = frame % 120;
  const isBlinking =
    enableBlink && emotion !== 'smile' && blinkPhase >= 115 && blinkPhase <= 119;

  const mouthState: MouthState = mouthCues
    ? (mouthCues[frame] ?? 0)
    : fallbackMouthStateAtFrame(frame);

  const eyesSrc = isBlinking
    ? assets.eyes.closed
    : emotion === 'surprise'
      ? assets.eyes.surprise
      : emotion === 'smile'
        ? assets.eyes.smile
        : assets.eyes.open;

  const showPupils = !isBlinking && emotion !== 'smile';

  const mouthSrc =
    emotion === 'smile'
      ? mouthState === 0
        ? assets.mouth.smileClosed
        : assets.mouth.smileOpen
      : mouthState === 0
        ? assets.mouth.closed
        : mouthState === 1
          ? assets.mouth.half
          : assets.mouth.open;

  return (
    <div
      style={{
        position: 'relative',
        width: size,
        height: size,
        transform: `translateY(${bob}px)`,
        filter: showShadow
          ? 'drop-shadow(0 14px 20px rgba(52, 94, 138, 0.16))'
          : undefined,
      }}
    >
      {/* Fixed Remotion layer order:
          hair_back -> body -> head_base -> eyebrows -> eyes -> pupils -> mouth -> hair_front
      */}
      <AvatarLayer src={assets.hairBack} />
      <AvatarLayer src={assets.body[pose]} />
      <AvatarLayer src={assets.headBase} />
      <AvatarLayer src={assets.eyebrow[emotion]} />
      <AvatarLayer src={eyesSrc} />
      {showPupils ? <AvatarLayer src={assets.pupilLeft} /> : null}
      {showPupils ? <AvatarLayer src={assets.pupilRight} /> : null}
      <AvatarLayer src={mouthSrc} />
      <AvatarLayer src={assets.hairFront} />
    </div>
  );
};
