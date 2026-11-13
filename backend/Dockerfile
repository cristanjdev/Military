# Production image for the Laravel API (Railway). Replaces the Railpack build, whose PHP
# version resolution currently fails because the mise PHP plugin repository it clones is gone.
FROM dunglas/frankenphp:1-php8.4

RUN install-php-extensions pdo_mysql mbstring bcmath gd zip intl opcache exif

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /app

# Dependencies first so this layer is cached until composer.lock changes.
COPY composer.json composer.lock ./
RUN composer install --no-dev --prefer-dist --no-scripts --no-autoloader --no-interaction

COPY . .
RUN composer dump-autoload --optimize --no-dev --no-scripts \
    && mkdir -p storage/framework/cache/data storage/framework/sessions storage/framework/views storage/logs bootstrap/cache \
    && chmod -R ug+rwx storage bootstrap/cache

# Laravel caches read environment variables, which Railway only provides at runtime.
# Migrations run here too: Railway's preDeployCommand left the database behind the code
# (found 2026-11-13 with seven migrations pending). One replica, so no migration race.
# The scheduler (overdue sweep, tracker watchdog, maintenance reminders) runs beside the web
# server in the same container, restarting if it ever exits.
CMD ["sh", "-c", "php artisan package:discover --ansi && php artisan migrate --force --no-interaction && php artisan config:cache && php artisan route:cache && php artisan view:cache && php artisan event:cache && { (while true; do php artisan schedule:work --no-interaction || true; sleep 10; done) & } && exec frankenphp php-server --root public/ --listen :${PORT:-8080}"]
