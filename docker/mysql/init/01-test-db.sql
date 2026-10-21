-- Runs once on first container start: a separate database for the API test suite.
CREATE DATABASE IF NOT EXISTS holydeen_erp_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON holydeen_erp_test.* TO 'holydeen'@'%';
FLUSH PRIVILEGES;
