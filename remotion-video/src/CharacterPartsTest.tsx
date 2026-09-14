import React from 'react';
import {AbsoluteFill, useCurrentFrame} from 'remotion';
import {
  LayeredAvatar,
  type CharacterExpression,
} from './LayeredAvatar';

export const CHARACTER_TEST_FPS = 30;
export const CHARACTER_TEST_SEGMENT_FRAMES = CHARACTER_TEST_FPS * 3;

const expressions: CharacterExpression[] = [
  'normal',
  'serious',
  'surprise',
  'smile',
];

const expressionLabels: Record<CharacterExpression, string> = {
  normal: 'NORMAL',
  serious: 'SERIOUS',
  surprise: 'SURPRISE',
  smile: 'SMILE',
};

export const CHARACTER_TEST_DURATION =
  expressions.length * CHARACTER_TEST_SEGMENT_FRAMES;

export const CharacterPartsTest: React.FC = () => {
  const frame = useCurrentFrame();
  const expressionIndex = Math.min(
    expressions.length - 1,
    Math.floor(frame / CHARACTER_TEST_SEGMENT_FRAMES),
  );
  const emotion = expressions[expressionIndex];
  const localFrame = frame % CHARACTER_TEST_SEGMENT_FRAMES;
  const mouthPhase = localFrame % 30;
  const mouthLabel =
    emotion === 'normal' || emotion === 'smile'
      ? mouthPhase < 10
        ? 'smile-closed'
        : 'smile-open'
      : mouthPhase < 10
        ? 'closed'
        : mouthPhase < 20
          ? 'half'
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
        Expression Test
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
        body_normal fixed / 4 expressions × 3 seconds
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
          pose="normal"
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
          NORMAL FIXED
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
          normal: smile mouth pair
          <br />
          blink: 約4秒周期 / 5 frames
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
        normal → serious → surprise → smile / each 3 sec
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
