import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {
  LayeredAvatar,
  type CharacterExpression,
  type CharacterPose,
} from './LayeredAvatar';

export const CHARACTER_TEST_FPS = 30;
export const CHARACTER_TEST_SEGMENT_FRAMES = 45;

const poses: CharacterPose[] = [
  'normal',
  'point_up',
  'caution',
  'positive',
  'explain',
];

const expressions: CharacterExpression[] = [
  'normal',
  'serious',
  'surprise',
  'smile',
];

const poseLabels: Record<CharacterPose, string> = {
  normal: 'NORMAL',
  point_up: 'POINT UP',
  caution: 'CAUTION',
  positive: 'POSITIVE',
  explain: 'EXPLAIN',
};

const expressionLabels: Record<CharacterExpression, string> = {
  normal: 'NORMAL',
  serious: 'SERIOUS',
  surprise: 'SURPRISE',
  smile: 'SMILE',
};

export const CHARACTER_TEST_DURATION =
  poses.length * expressions.length * CHARACTER_TEST_SEGMENT_FRAMES;

export const CharacterPartsTest: React.FC = () => {
  const frame = useCurrentFrame();
  const comboIndex = Math.min(
    poses.length * expressions.length - 1,
    Math.floor(frame / CHARACTER_TEST_SEGMENT_FRAMES),
  );
  const poseIndex = Math.floor(comboIndex / expressions.length);
  const expressionIndex = comboIndex % expressions.length;
  const pose = poses[poseIndex];
  const emotion = expressions[expressionIndex];
  const localFrame = frame % CHARACTER_TEST_SEGMENT_FRAMES;
  const mouthLabel =
    localFrame % 30 < 10
      ? 'closed'
      : localFrame % 30 < 20
        ? 'half / smile-open'
        : 'open';

  return (
    <AbsoluteFill
      style={{
        background:
          'linear-gradient(135deg, #f7fbff 0%, #eef5fc 45%, #ffffff 100%)',
        color: '#142033',
        fontFamily: 'Noto Sans JP, sans-serif',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 72,
          top: 54,
          fontSize: 48,
          lineHeight: 1.2,
          fontWeight: 800,
        }}
      >
        Character Parts Test
      </div>
      <div
        style={{
          position: 'absolute',
          left: 74,
          top: 120,
          fontSize: 24,
          fontWeight: 600,
          color: '#607089',
        }}
      >
        23-layer Remotion avatar / 5 poses × 4 expressions
      </div>

      <div
        style={{
          position: 'absolute',
          left: 105,
          bottom: 36,
          width: 880,
          height: 880,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <LayeredAvatar
          pose={pose}
          emotion={emotion}
          size={850}
          bobAmount={3}
          enableBlink
          showShadow
        />
      </div>

      <div
        style={{
          position: 'absolute',
          right: 90,
          top: 210,
          width: 700,
          padding: '46px 54px',
          borderRadius: 30,
          background: 'rgba(255,255,255,0.92)',
          boxShadow: '0 18px 50px rgba(52, 94, 138, 0.12)',
          border: '1px solid rgba(180,205,230,0.55)',
          boxSizing: 'border-box',
        }}
      >
        <div style={{fontSize: 24, fontWeight: 700, color: '#6c7d94'}}>
          POSE
        </div>
        <div style={{fontSize: 58, fontWeight: 800, marginTop: 4}}>
          {poseLabels[pose]}
        </div>

        <div
          style={{
            height: 1,
            background: '#dbe7f2',
            margin: '28px 0',
          }}
        />

        <div style={{fontSize: 24, fontWeight: 700, color: '#6c7d94'}}>
          EXPRESSION
        </div>
        <div style={{fontSize: 58, fontWeight: 800, marginTop: 4}}>
          {expressionLabels[emotion]}
        </div>

        <div
          style={{
            marginTop: 34,
            padding: '20px 24px',
            borderRadius: 18,
            background: '#edf5fc',
            fontSize: 24,
            fontWeight: 700,
            lineHeight: 1.55,
          }}
        >
          mouth: {mouthLabel}
          <br />
          blink: 約4秒周期 / 5 frames
          <br />
          idle: ±3px vertical only
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          right: 90,
          bottom: 88,
          width: 700,
          padding: '22px 26px',
          borderRadius: 18,
          background: 'rgba(20,32,51,0.94)',
          color: 'white',
          boxSizing: 'border-box',
          fontSize: 20,
          lineHeight: 1.55,
          fontWeight: 600,
        }}
      >
        hair_back → body → head_base → eyebrows → eyes → pupils → mouth → hair_front
      </div>

      <div
        style={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          height: 10,
          width: `${((frame + 1) / CHARACTER_TEST_DURATION) * 100}%`,
          background: '#4f8fcf',
        }}
      />
    </AbsoluteFill>
  );
};
