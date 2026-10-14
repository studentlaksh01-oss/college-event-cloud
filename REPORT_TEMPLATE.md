# CA3 Mini-Project Report Template

**Report filename:** `ICC01_Group_<GROUP_NUMBER>` or `ICC02_Group_<GROUP_NUMBER>` (use your actual class code and group number, and follow the instructor's exact required file format).

## Title
Cloud-Based College Event Registration and Attendance Management System with Load Balancing

## 1. Abstract
CampusConnect is a web-based system designed to simplify college event publishing, student registration, QR-ticket generation and attendance tracking. The system uses a Node.js/Express API, PostgreSQL persistence and Google Cloud Run deployment. Cloud Run's managed ingress routes incoming requests and can scale application instances according to demand. Security measures include password hashing, signed HttpOnly cookies, role-based access checks, parameterized SQL, rate limiting and HTTPS at the cloud endpoint.

## 2. Problem Statement
Manual event registration and attendance processes can lead to duplicate records, slow check-in, difficult reporting and limited ability to handle traffic spikes. A centralized system is required to manage events and registrations and make attendance reporting easier.

## 3. Objectives
- Provide student registration and login.
- Allow organizers to create events with capacity and registration deadlines.
- Prevent duplicate registration and enforce capacity.
- Generate QR-based tickets and validate check-in.
- Deploy the application on a cloud platform.
- Explain and demonstrate managed load balancing/scaling.
- Apply and test application and database security controls.

## 4. Scope
### Included
Student accounts, event listings, event creation, registration, QR ticket generation, admin check-in, reports, cloud hosting and security controls.

### Excluded from the prototype
Email/SMS alerts, payments, event cancellation workflow, native mobile app and full enterprise monitoring.

## 5. Technology Stack
- Frontend: HTML, CSS, JavaScript
- Backend: Node.js and Express
- Database: PostgreSQL
- Cloud deployment: Google Cloud Run
- Managed database: Neon PostgreSQL (or provider actually used)
- Version control: GitHub
- Security: Helmet, bcrypt, JWT, HttpOnly cookie, rate limiting, parameterized SQL

## 6. System Architecture
Insert an architecture diagram showing users/browser → Cloud Run HTTPS endpoint and managed request routing → application container instances → managed PostgreSQL. Clearly label the load-balancing behavior as Cloud Run-managed unless a separate external Application Load Balancer was actually provisioned.

## 7. Functional Modules
1. Authentication
2. Event management
3. Student registration
4. QR ticket generation
5. Attendance check-in
6. Admin registration report
7. Health and instance diagnostics

## 8. Database Design
### Users
`id`, `name`, `email`, `password_hash`, `role`, `created_at`

### Events
`id`, `title`, `description`, `venue`, `starts_at`, `registration_deadline`, `capacity`, `created_by`, `created_at`

### Registrations
`id`, `user_id`, `event_id`, `ticket_token`, `attended_at`, `created_at`

Constraints: unique user email; unique `(user_id, event_id)` registration; unique ticket token; foreign keys; positive capacity check.

## 9. Cloud Deployment
Record the actual provider, region, service URL, database provider, deployment date and configuration. Do not include credentials or secret values. Explain Cloud Run managed ingress, request routing and autoscaling. If a separate load balancer is configured, document its exact resource and backend.

## 10. Security Implementation
Document the implemented controls: password hashing, session cookie flags, JWT expiry and verification, role checks, input validation, SQL parameters, rate limiting, security headers, HTTPS and protected secrets. Include actual test evidence.

## 11. Testing
Fill the result column only after running each test.

| Test | Expected result | Actual result |
|---|---|---|
| Student account registration | Account created | Fill in |
| Incorrect login password | Rejected | Fill in |
| Student opens admin endpoint | HTTP 403 | Fill in |
| Duplicate event registration | HTTP 409 | Fill in |
| Registration after deadline | Rejected | Fill in |
| Event capacity reached | Additional registration rejected | Fill in |
| Valid ticket check-in | Attendance recorded | Fill in |
| Reuse checked-in ticket | Rejected | Fill in |
| Database health endpoint | Healthy when DB is available | Fill in |
| Concurrent requests to instance endpoint | Record observed routing/scaling | Fill in |

## 12. Load Balancing Demonstration
Describe the test setup, number of concurrent requests, Cloud Run concurrency configuration, observed instance/revision logs and results. Include screenshots of Cloud Run metrics/logs. Be accurate: repeated requests can be handled by the same instance, and a successful request alone does not prove multi-instance distribution. Record an instance failure test only if actually performed.

## 13. Results and Screenshots
Insert screenshots of the home page, event creation, event listing, registration, QR ticket, admin check-in, database records, Cloud Run deployment, security tests, GitHub repository and load-balancing/scaling evidence. Redact personal data and all secrets.

## 14. Limitations
List prototype limitations honestly, including absent notifications, camera-based QR scanning (if not implemented), and any unperformed scale/failure tests.

## 15. Future Enhancements
- Camera-based QR scanning
- Email confirmations and reminders
- Registration cancellation and waitlist
- Analytics dashboard and CSV export
- Automated database migrations and backups
- Monitoring, alerting and controlled load testing
- Separate external Application Load Balancer if required by the evaluation rubric

## 16. Conclusion
Summarize the working features, actual cloud deployment, security controls tested and observed load-balancing/scaling behavior. Do not claim results that were not measured.

## 17. References
- Google Cloud Run documentation: https://cloud.google.com/run/docs
- Neon documentation: https://neon.tech/docs
- Node.js documentation: https://nodejs.org/docs
- Express documentation: https://expressjs.com/
- PostgreSQL documentation: https://www.postgresql.org/docs/
