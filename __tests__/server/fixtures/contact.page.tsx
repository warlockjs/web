/**
 * The minimum a page can be: a URL and a component
 * (v5/app src/app/main/web/contact-us.page.tsx — "this file is two lines and
 * a component"). No middleware, no validation, no loader, no metadata.
 */
export const route = "/contact-us";

export default function ContactUsPage() {
  return (
    <main>
      <h1>Contact us</h1>
      <p>support@fixture.store</p>
    </main>
  );
}
