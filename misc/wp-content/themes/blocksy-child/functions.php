<?php
// Exit if accessed directly
if ( ! defined( 'ABSPATH' ) ) {
  exit;
}

// Enqueue parent theme stylesheet
add_action( 'wp_enqueue_scripts', function() {
  wp_enqueue_style( 'parent-style', get_template_directory_uri() . '/style.css' );
});

// Discord integration constants
define('EV_DISCORD_CLIENT_ID',    '1386802909320052787');
define('EV_DISCORD_CLIENT_SECRET','y-enQ-jXAEgi7hjjfLq0ljR5NI9DsUkF');
define('EV_DISCORD_REDIRECT_URI',  home_url('/discord-callback'));
define('EV_DISCORD_GUILD',        '1386808799654055967');
define('EV_DISCORD_ROLE',         '1387055363609723011');
define('EV_BOT_API_URL',          'https://edgeviper-bot.onrender.com/discord-role');
define('EV_BOT_API_KEY',          '982398hrhiu24988h49u29hgf08942ij');
define('EV_DISCORD_BOT_TOKEN',    'MTM4NjgwMjkwOTMyMDA1Mjc4Nw.G1CACq.A6CEVm37exA6cD0kPWy7H89tTDI_vZFJeepLWk');

// ——————————————————————————————
// TEMP: simulate subscription create via URL
// Usage: https://edgeviper.co.uk/?force_create=SUB_ID
// ——————————————————————————————
add_action('init', function(){
  if ( isset($_GET['force_create']) && current_user_can('manage_options') ) {
    $sub_id = intval($_GET['force_create']);
    if ( class_exists('MeprSubscription') ) {
      $sub = MeprSubscription::get_one($sub_id);
      if ( $sub ) {
        do_action('mepr-event-subscription-created', $sub);
        exit("✅ Fired subscription-created for #{$sub_id}.");
      }
    }
    exit("⚠️ Subscription #{$sub_id} not found.");
  }
});
// ——————————————————————————————
// TEMP: simulate subscription expire via URL
// Usage: https://edgeviper.co.uk/?force_expire=SUB_ID
// ——————————————————————————————
add_action('init', function(){
  if ( isset($_GET['force_expire']) && current_user_can('manage_options') ) {
    $sub_id = intval($_GET['force_expire']);
    if ( class_exists('MeprSubscription') ) {
      $sub = MeprSubscription::get_one($sub_id);
      if ( $sub ) {
        do_action('mepr-event-subscription-expired', $sub);
        exit("✅ Fired subscription-expired for #{$sub_id}.");
      }
    }
    exit("⚠️ Subscription #{$sub_id} not found.");
  }
});

// ——————————————————————————————
// Show “Connect Discord” on the Thank-You page
// ——————————————————————————————
add_action('mepr-event-signup-complete', function($user_id){
  if ( ! mepr_is_paid_subscriber($user_id) ) return;
  $url = 'https://discord.com/api/oauth2/authorize'
       . '?client_id='    . EV_DISCORD_CLIENT_ID
       . '&redirect_uri=' . rawurlencode(EV_DISCORD_REDIRECT_URI)
       . '&response_type=code'
       . '&scope=identify%20guilds.join';
  echo '<p><a class="mepr-button" href="'. esc_url($url) .'">'
       . '🔗 Connect your Discord</a></p>';
});

// ——————————————————————————————————————————————
// Discord Connect Shortcode for Thank-You / Dashboard
// ——————————————————————————————————————————————
function ev_discord_connect_shortcode() {
  if ( ! is_user_logged_in() ) {
    return '<p>Please <a href="' . wp_login_url() . '">log in</a> to connect Discord.</p>';
  }
  $uid        = get_current_user_id();
  $discord_id = get_user_meta( $uid, 'mepr_discord_id', true );
  if ( $discord_id ) {
    return '<p>✅ You’re already connected to Discord.</p>';
  }
  $url = 'https://discord.com/api/oauth2/authorize'
       . '?client_id='    . EV_DISCORD_CLIENT_ID
       . '&redirect_uri=' . rawurlencode(EV_DISCORD_REDIRECT_URI)
       . '&response_type=code'
       . '&scope=identify%20guilds.join';
  return '<p class="connect-disc"><a class="mepr-button" href="' . esc_url( $url ) . '">'
       . '🔗 Connect your Discord</a></p><p>Ensure you are logged in to the Discord you wish to join Edge Viper with before following the above link. You will also shortly receive an e-mail outlining some suggested next steps. Follow these steps to get fully accustomed with Edge Viper and begin your value betting journey with us!';
}
add_shortcode( 'ev_discord_connect', 'ev_discord_connect_shortcode' );

// ——————————————————————————————
// OAuth2 callback: exchange code, save ID, call bot
// ——————————————————————————————
add_action('init', function(){
  if ( empty($_GET['code']) || false === strpos($_SERVER['REQUEST_URI'],'discord-callback') ) {
    return;
  }
  $code = sanitize_text_field($_GET['code']);
  // 1) Exchange code for token
  $resp = wp_remote_post('https://discord.com/api/oauth2/token', [
    'headers' => ['Content-Type'=>'application/x-www-form-urlencoded'],
    'body'    => http_build_query([
      'client_id'     => EV_DISCORD_CLIENT_ID,
      'client_secret' => EV_DISCORD_CLIENT_SECRET,
      'grant_type'    => 'authorization_code',
      'code'          => $code,
      'redirect_uri'  => EV_DISCORD_REDIRECT_URI,
    ]),
  ]);
  $data = json_decode(wp_remote_retrieve_body($resp), true);
  if ( empty($data['access_token']) ) {
    wp_die('⚠️ Discord login failed. Please try again.');
  }
  // 2) Fetch the user’s Discord ID
  $user = json_decode( wp_remote_retrieve_body( wp_remote_get('https://discord.com/api/users/@me', [
    'headers' => ['Authorization'=>'Bearer ' . $data['access_token']],
  ]) ), true );
  $discord_id = $user['id'] ?? '';
  
// 2.5) Invite user into the guild *and* assign the Viper role
$response = wp_remote_request(
  "https://discord.com/api/guilds/".EV_DISCORD_GUILD."/members/{$discord_id}",
  [
    'method'  => 'PUT',
    'headers' => [
      'Authorization' => 'Bot ' . EV_DISCORD_BOT_TOKEN,
      'Content-Type'  => 'application/json',
    ],
    'body'    => wp_json_encode([
      'access_token' => $data['access_token'],
      'roles'        => [ EV_DISCORD_ROLE ],
    ]),
  ]
);

// Debug: log full response code & body if it fails
$response_code = wp_remote_retrieve_response_code($response);
$response_body = wp_remote_retrieve_body($response);
if ( is_wp_error($response) || $response_code !== 201 ) {
  error_log(sprintf(
    'Discord guild invite & role assign failed for %s: HTTP %s %s',
    $discord_id,
    $response_code,
    $response_body
  ));
}

  // 3) Save to WP user meta
  $current = get_current_user_id();
  update_user_meta($current, 'mepr_discord_id', $discord_id);

  // 4) Redirect into your Discord server’s welcome channel
  $channel_id = '1386808799654055970';
  $url        = "https://discord.com/channels/" . EV_DISCORD_GUILD . "/" . $channel_id;
  wp_redirect( esc_url_raw($url) );
  exit;
});

// Add Discord role on subscription creation
add_action('mepr-event-subscription-created', function( $subscription ) {
  $user_id    = $subscription->user_id;
  $discord_id = get_user_meta( $user_id, 'mepr_discord_id', true );
  if ( ! $discord_id ) return;

  wp_remote_post( EV_BOT_API_URL, [
    'headers' => [
      'Authorization' => 'Bearer ' . EV_BOT_API_KEY,
      'Content-Type'  => 'application/json',
    ],
    'body'    => wp_json_encode([
      'action'     => 'add_role',
      'discord_id' => $discord_id,
      'role_id'    => EV_DISCORD_ROLE,
      'guild_id'   => EV_DISCORD_GUILD,
    ]),
  ]);
});

// ——————————————————————————————
// Remove Viper role when the subscription truly EXPIRES
// ——————————————————————————————
add_action('mepr-event-subscription-expired', function($subscription){
  $user_id    = $subscription->user_id;
  $discord_id = get_user_meta($user_id, 'mepr_discord_id', true);
  if ( ! $discord_id ) {
    return;
  }
  wp_remote_post(EV_BOT_API_URL, [
    'headers' => [
      'Authorization' => 'Bearer ' . EV_BOT_API_KEY,
      'Content-Type'  => 'application/json',
    ],
    'body'    => wp_json_encode([
      'action'     => 'remove_role',
      'discord_id' => $discord_id,
      'role_id'    => EV_DISCORD_ROLE,
      'guild_id'   => EV_DISCORD_GUILD,
    ]),
  ]);
});

// ——————————————————————————————
// Prepend alert above the entire account page wrapper
// ——————————————————————————————
add_filter('the_content', function( $content ) {
  if ( ! is_user_logged_in() || ! is_page( 'account' ) ) {
    return $content;
  }
  $discord_id = get_user_meta( get_current_user_id(), 'mepr_discord_id', true );
  if ( $discord_id ) {
    return $content;
  }
  $alert = '<div class="mepr-alert connect-disc mepr-error" style="margin-bottom:1em;">'
         . '⚠️ Please connect your Discord to access the community. '
         . '<a href="https://discord.com/api/oauth2/authorize'
           . '?client_id='    . EV_DISCORD_CLIENT_ID
           . '&redirect_uri=' . rawurlencode( EV_DISCORD_REDIRECT_URI )
           . '&response_type=code&scope=identify%20guilds.join'
           . '">Connect Now</a>.'
         . '</div>';

  return $alert . $content;
}, 5 );

// Custom REST endpoint for user settings
add_action('rest_api_init', function() {
  register_rest_route('ev/v1', '/user-settings', [
    'methods'             => 'GET',
    'callback'            => function( WP_REST_Request $req ) {
      $discord = sanitize_text_field( $req->get_param('discord_id') );
      $users   = get_users([
        'meta_key'   => 'mepr_discord_id',
        'meta_value' => $discord,
        'number'     => 1,
      ]);
      if ( empty( $users ) ) {
        return new WP_Error( 'no_user', 'Not linked', [ 'status' => 404 ] );
      }
      $id = $users[0]->ID;
      return [
        'bankroll'     => (float) get_user_meta( $id, 'mepr_bankroll', true ) ?: 0,
        'staking_mode' => get_user_meta( $id, 'mepr_staking_mode', true ) ?: 'kelly',
        'kelly_pct'    => (float) get_user_meta( $id, 'mepr_kelly_percentage', true ) ?: 20,
        'flat_stake'   => (float) get_user_meta( $id, 'mepr_flat_stake', true ) ?: 0,
        'stw_amount'   => (float) get_user_meta( $id, 'mepr_stw_amount', true ) ?: 60,
      ];
    },
    'permission_callback' => '__return_true',
  ]);
});

// Disable MemberPress auto-insert registration form for membership ID 123
add_filter('mepr-membership-registration-form-auto-insert', function( $auto_insert, $membership_id ) {
  if ( intval( $membership_id ) === 123 ) {
    return false;
  }
  return $auto_insert;
}, 10, 2);

// === Bet Settings Tab & Content ===
// 1) Add the Bet Settings tab in the Account nav
add_action( 'mepr_account_nav', function() {
  $active = ( isset( $_GET['action'] ) && $_GET['action'] === 'bet-settings' ) ? 'mepr-active-nav-tab' : '';
  echo '<span class="mepr-nav-item bet-settings ' . esc_attr( $active ) . '">';
    echo '<a href="' . esc_url( home_url( '/account/?action=bet-settings' ) ) . '">'
        . esc_html__( 'Bet Settings', 'edgeviper' )
        . '</a>';
  echo '</span>';
});

// 2) Hook the content area when that tab’s clicked
add_action( 'mepr_account_nav_content', function( $action ) {
  if ( $action !== 'bet-settings' ) return;
  if ( ! is_user_logged_in() ) {
    echo '<p>' . esc_html__( 'Please log in to manage your Bet Settings.', 'edgeviper' ) . '</p>';
    return;
  }

  $user_id = get_current_user_id();

  // Handle save
  if ( 'POST' === $_SERVER['REQUEST_METHOD'] && check_admin_referer( 'ev_bet_settings_save', 'ev_bet_settings_nonce' ) ) {
    foreach ( [ 'mepr_staking_mode', 'mepr_bankroll', 'mepr_kelly_percentage', 'mepr_flat_stake', 'mepr_stw_amount' ] as $slug ) {
      if ( isset( $_POST[ $slug ] ) ) {
        update_user_meta( $user_id, $slug, sanitize_text_field( wp_unslash( $_POST[ $slug ] ) ) );
      }
    }
    echo '<div class="mp-success">' . esc_html__( 'Settings saved.', 'edgeviper' ) . '</div>';

    // Notify Discord bot via webhook
    $payload = [
      'discord_id'   => get_user_meta( $user_id, 'mepr_discord_id', true ),
      'staking_mode' => sanitize_text_field( $_POST['mepr_staking_mode'] ),
      'bankroll'     => floatval( $_POST['mepr_bankroll'] ),
      'kelly_pct'    => isset( $_POST['mepr_kelly_percentage'] ) ? floatval( $_POST['mepr_kelly_percentage'] ) : null,
      'flat_stake'   => isset( $_POST['mepr_flat_stake'] )       ? floatval( $_POST['mepr_flat_stake'] )       : null,
      'stw_amount'   => isset( $_POST['mepr_stw_amount'] )       ? floatval( $_POST['mepr_stw_amount'] )       : null,
    ];
    wp_remote_post( 'https://edgeviper-bot.onrender.com/settings-updated', [
	  'headers' => [
	    'Content-Type'  => 'application/json',
	    'Authorization' => 'Bearer ' . ( defined('BOT_WEBHOOK_KEY') ? BOT_WEBHOOK_KEY : '' ),
	  ],
      'body'    => wp_json_encode( $payload ),
      'timeout' => 5,
    ]);
  }

  // Fetch values
  $vals = [];
  foreach ( [ 'mepr_staking_mode', 'mepr_bankroll', 'mepr_kelly_percentage', 'mepr_flat_stake', 'mepr_stw_amount' ] as $slug ) {
    $default = ( 'mepr_stw_amount' === $slug ) ? 60 : '';
    $vals[ $slug ] = esc_attr( get_user_meta( $user_id, $slug, true ) ?: $default );
  }
  ?>
  <form method="post" class="ev-bet-settings-form">
    <?php wp_nonce_field( 'ev_bet_settings_save', 'ev_bet_settings_nonce' ); ?>
    <p>
      <label for="mepr_staking_mode"><?php esc_html_e( 'Staking Mode', 'edgeviper' ); ?></label><br>
      <select name="mepr_staking_mode" id="mepr_staking_mode" required>
        <option value="kelly" <?php selected( $vals['mepr_staking_mode'], 'kelly' ); ?>><?php esc_html_e( 'Kelly', 'edgeviper' ); ?></option>
        <option value="flat"  <?php selected( $vals['mepr_staking_mode'], 'flat' );  ?>><?php esc_html_e( 'Flat', 'edgeviper' );  ?></option>
        <option value="stw"   <?php selected( $vals['mepr_staking_mode'], 'stw' );   ?>><?php esc_html_e( 'Stake to Win (STW)', 'edgeviper' ); ?></option>
      </select>
    </p>
    <p>
      <label for="mepr_bankroll"><?php esc_html_e( 'Bankroll (£)', 'edgeviper' ); ?></label><br>
      <input type="number" step="0.01" name="mepr_bankroll" id="mepr_bankroll" value="<?php echo $vals['mepr_bankroll']; ?>" required>
    </p>
    <p class="ev-field-kelly">
      <label for="mepr_kelly_percentage"><?php esc_html_e( 'Kelly Percentage (%)', 'edgeviper' ); ?></label><br>
      <input type="number" step="1" name="mepr_kelly_percentage" id="mepr_kelly_percentage" value="<?php echo $vals['mepr_kelly_percentage']; ?>" required>
    </p>
    <p class="ev-field-flat">
      <label for="mepr_flat_stake"><?php esc_html_e( 'Flat Stake (£)', 'edgeviper' ); ?></label><br>
      <input type="number" step="0.01" name="mepr_flat_stake" id="mepr_flat_stake" value="<?php echo $vals['mepr_flat_stake']; ?>" required>
    </p>
    <p class="ev-field-stw">
      <label for="mepr_stw_amount"><?php esc_html_e( 'Stake-to-Win Amount (STW) (£)', 'edgeviper' ); ?></label><br>
      <input type="number" step="0.01" name="mepr_stw_amount" id="mepr_stw_amount" value="<?php echo $vals['mepr_stw_amount']; ?>" required>
    </p>
    <p>
      <button type="submit" class="mepr-submit-button"><?php esc_html_e( 'Save Bet Settings', 'edgeviper' ); ?></button>
    </p>
  </form>
<script>
  (function($){
    function toggleFields() {
      var mode = $('#mepr_staking_mode').val();

      // show/hide the rows as before
      $('.ev-field-kelly').toggle(mode === 'kelly');
      $('.ev-field-flat').toggle(mode === 'flat');
      $('.ev-field-stw').toggle(mode === 'stw');

      // ⬇️ dynamically set required only on the visible inputs
      $('#mepr_kelly_percentage').prop('required', mode === 'kelly');
      $('#mepr_flat_stake').       prop('required', mode === 'flat');
      $('#mepr_stw_amount').       prop('required', mode === 'stw');
      // bankroll is always required, so you can leave its `required` in the markup
    }

    $(document).ready(function(){
      $('#mepr_staking_mode').on('change', toggleFields);
      toggleFields(); // run on page load
    });
  })(jQuery);
</script>
<?php
});

// Bypass logout confirmation
function bypass_logout_confirmation() {
  if ( isset($_GET['action']) && $_GET['action'] === 'logout' ) {
    wp_logout();
    wp_safe_redirect( home_url() );
    exit;
  }
}
add_action( 'init', 'bypass_logout_confirmation' );

add_action( 'send_headers', function() {
  if ( is_user_logged_in()
    && isset( $_GET['action'] )
    && $_GET['action'] === 'my-bets'
  ) {
    // strip any existing Cache-Control / Expires / Pragma
    header_remove( 'Cache-Control' );
    header_remove( 'Expires' );
    header_remove( 'Pragma'    );

    // set your own cache rules — NO shared‐cache, no store, no fallback
    header( 'Cache-Control: private, no-cache, no-store, must-revalidate, max-age=0, s-maxage=0', true );
    header( 'Pragma: no-cache', true );
    header( 'Expires: 0', true );
  }
}, 100 );