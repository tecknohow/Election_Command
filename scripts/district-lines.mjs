/**
 * States whose newest Census district file (cd120) holds a map that was NOT used in the November
 * 2026 general election, so the 2024 lines (cd119) still apply. Checked against NYT, which compares
 * these districts with their own 2024 House race instead of the 2024 presidential race on new lines.
 *
 *  - MO: the 2025 mid-decade map was used only in the August primaries; the general election ran
 *    on the 2023 lines (Wikipedia, "2026 United States House of Representatives elections in Missouri").
 */
export const OLD_LINES_2026 = new Set(['MO']);
