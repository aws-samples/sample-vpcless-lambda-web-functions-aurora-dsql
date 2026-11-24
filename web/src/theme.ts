import { Alert, Button, Checkbox, createTheme, type CSSVariablesResolver, type MantineColorsTuple, Modal, rem, TextInput } from '@mantine/core';

// Shades chosen so text and controls meet WCAG contrast in light and dark.
const accent: MantineColorsTuple = [
  '#e3f4f3', '#d0e8e6', '#a4d1cd', '#75bab3', '#53a79e', '#419b91', '#36958b', '#237a70', '#1b7369', '#036358',
];

const gray: MantineColorsTuple = [
  '#f6f5f3', '#eceae7', '#d9d6d1', '#c3beb6', '#aca69c', '#938d82', '#706a60', '#5a554d', '#413d38', '#2b2823',
];

const dark: MantineColorsTuple = [
  '#d6d2cb', '#bdb8af', '#9a958c', '#7c766c', '#4a463f', '#39352f', '#2e2b26', '#262422', '#1e1c19', '#161512',
];

/** Horizontal padding of a size="sm" Button, in px. A negative margin of this size lines the button's text up with the edge of the list. */
export const BUTTON_PADDING = 18;

export const theme = createTheme({
  primaryColor: 'accent',
  primaryShade: { light: 8, dark: 7 },
  colors: { accent, gray, dark },
  white: '#fbfaf8',
  black: '#2b2823',
  defaultRadius: 'md',
  cursorType: 'pointer',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
  headings: { fontWeight: '650' },
  components: {
    // 44px touch targets. Label weights are in app.css.
    Button: Button.extend({
      styles: { root: { minHeight: 44 } },
    }),
    // Alert text stays at the body color; the close icon gets a 44px hit area.
    // The rule and padding are `.app-notice` in app.css.
    Alert: Alert.extend({
      styles: {
        message: { color: 'var(--mantine-color-text)' },
        closeButton: { width: 44, height: 44, margin: -14 },
        root: { background: 'transparent' },
      },
    }),
    // The default border is too faint on the dark background to see the box.
    // root/body/inner give a 44x44 hit area around the box; because the inner
    // is larger than the box, pin the check mark to the box size (60% of it)
    // so it does not overflow (Mantine sizes the mark to 60% of the inner).
    Checkbox: Checkbox.extend({
      styles: {
        root: { minHeight: 44 },
        body: { minHeight: 44, alignItems: 'center' },
        inner: { minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' },
        input: { borderColor: 'var(--mantine-color-dimmed)' },
        icon: { width: 'calc(var(--checkbox-size) * 0.6)' },
        // Line the first line of the label (and the description under it) up
        // with the 44px box's vertical centre.
        label: { paddingTop: 10 },
        description: { paddingTop: 2 },
      },
    }),
    // A border that meets the 3:1 non-text contrast, and a 44px touch target.
    TextInput: TextInput.extend({
      vars: () => ({ wrapper: { '--input-bd': 'var(--app-input-border)', '--input-height': rem(44) } }),
    }),
    // shadow="none" resolves to an undefined variable in Mantine 9.8 and falls
    // back to shadow-xl, so box-shadow is set directly; the border keeps the
    // box visible in dark mode.
    Modal: Modal.extend({
      defaultProps: {
        transitionProps: { duration: 0 },
        overlayProps: { color: 'var(--mantine-color-black)', backgroundOpacity: 0.6 },
      },
      styles: {
        title: { fontWeight: 650 },
        content: { boxShadow: 'none', border: '1px solid var(--mantine-color-default-border)' },
      },
    }),
  },
});

export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    // The default placeholder is below 4.5:1; use the dimmed-text shade.
    '--mantine-color-placeholder': 'var(--mantine-color-gray-6)',
    '--mantine-color-default-border': 'var(--mantine-color-gray-3)',
    '--app-input-border': 'var(--mantine-color-gray-5)',
    '--app-focus': 'var(--mantine-color-accent-8)',
    // The destructive confirm button: strongest element on the dialog.
    '--app-danger-bg': 'var(--mantine-color-gray-8)',
    '--app-danger-color': 'var(--mantine-color-white)',
    // A subtle button's hover is otherwise a solid block that reads as a
    // second filled button next to Save, and drops below 4.5:1. Keep the gray
    // and accent hovers faint so the hovered label still meets contrast.
    '--mantine-color-gray-light-hover': 'var(--mantine-color-gray-0)',
    '--mantine-color-accent-light-hover': 'var(--mantine-color-gray-1)',
  },
  dark: {
    '--mantine-color-placeholder': 'var(--mantine-color-dark-2)',
    '--app-input-border': 'var(--mantine-color-dark-3)',
    '--app-focus': 'var(--mantine-color-accent-5)',
    // Dark: a light fill with dark text, so the confirm button is the
    // strongest element (gray-7 on the dark surface looked disabled).
    '--app-danger-bg': 'var(--mantine-color-dark-0)',
    '--app-danger-color': 'var(--mantine-color-dark-9)',
    // Hover a touch lighter than the surface (the input color), not darker.
    '--mantine-color-gray-light-hover': 'var(--mantine-color-dark-6)',
    '--mantine-color-accent-light-hover': 'var(--mantine-color-dark-6)',
    // Keep the dark ordering the same as light: subtle labels and alert text
    // stay at the body weight instead of becoming the brightest thing on
    // screen (Mantine's dark defaults push them to shade 0 / pure white).
    '--mantine-color-accent-light-color': 'var(--mantine-color-accent-4)',
    '--mantine-color-gray-light-color': 'var(--mantine-color-text)',
    '--mantine-color-default-color': 'var(--mantine-color-text)',
  },
});
