import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';

export const panel = style({
  border: `1px solid ${cssVarV2('layer/insideBorder/border')}`,
  borderRadius: 8,
  padding: 20,
  marginBottom: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  color: cssVarV2('text/primary'),
});
export const row = style({
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
});
export const description = style({
  color: cssVarV2('text/secondary'),
  fontSize: 13,
  lineHeight: '20px',
  margin: 0,
});
export const profile = style({
  borderTop: `1px solid ${cssVarV2('layer/insideBorder/border')}`,
  paddingTop: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
});
export const command = style({
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  fontSize: 12,
  padding: 12,
  borderRadius: 6,
  background: cssVarV2('layer/background/secondary'),
});
export const selector = style({
  maxWidth: '100%',
  minWidth: 180,
  borderRadius: 6,
  padding: 8,
  color: 'inherit',
  background: cssVarV2('layer/background/primary'),
  border: `1px solid ${cssVarV2('layer/insideBorder/border')}`,
});
