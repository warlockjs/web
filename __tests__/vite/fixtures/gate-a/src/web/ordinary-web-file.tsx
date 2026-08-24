/**
 * NOT a page, NOT a layout, NOT the app root — an ordinary file that merely
 * lives one level inside `src/web/`.
 *
 * It exists to show WHICH rule lets the app root through Gate A. If the root
 * were admitted by its name, this file would be refused. It is not.
 */
import { appLabel } from "./universal-helper";

export const ordinaryWebValue = `${appLabel}-ordinary`;
