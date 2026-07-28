Goal: exercise authenticated shopping, feedback, and broad route discovery while PTK scan is running.

Sequence:
1. Authentication: login using provided credentials.
2. Account route: open the profile page (`/profile`), then return to the main page.
3. Catalog search: search for "apple".
4. Add to cart: add 2 product items to the basket.
5. Cart route: open the basket.
6. Catalog search: search for "juice".
7. Feedback form: open the contact/customer-feedback form and submit a benign message.
8. Order history route: open order history when menu controls expose it.
9. Wallet route: open the digital wallet when menu controls expose it.
10. Saved address route: open saved addresses when menu controls expose them.
11. Saved payment route: open saved payment methods when menu controls expose them.
12. Broad coverage: crawl the site and find as many unique links as possible, including menu-only and hidden same-origin routes such as data export, digital wallet, saved addresses, saved payment methods, score board, support, complaints, and order history.

Constraints:
- Stay on the target origin.
- Do not delete the account.
