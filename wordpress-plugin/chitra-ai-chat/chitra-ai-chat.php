<?php
/**
 * Plugin Name: Chitra AI Chat
 * Plugin URI:  https://chitratech.com.np
 * Description: Add the Chitra AI assistant chat widget to your WordPress site in one click. Just enter your Chitra org ID.
 * Version:     1.0.0
 * Author:      Chitra Tech
 * License:     MIT
 * Text Domain: chitra-ai-chat
 */

if (!defined('ABSPATH')) exit; // no direct access

class Chitra_AI_Chat {

    public function __construct() {
        add_action('admin_menu', [$this, 'add_admin_page']);
        add_action('admin_init', [$this, 'register_settings']);
        add_action('wp_footer', [$this, 'render_widget']);
    }

    /** Settings page under WP Admin → Settings → Chitra AI */
    public function add_admin_page() {
        add_options_page(
            'Chitra AI Chat',
            'Chitra AI',
            'manage_options',
            'chitra-ai-chat',
            [$this, 'render_admin_page']
        );
    }

    public function register_settings() {
        register_setting('chitra_ai_chat', 'chitra_org_id');
        register_setting('chitra_ai_chat', 'chitra_api_url');
    }

    public function render_admin_page() {
        if (!current_user_can('manage_options')) return;
        $org_id   = esc_attr(get_option('chitra_org_id'));
        $api_url  = esc_attr(get_option('chitra_api_url', 'https://api.chitratech.com.np'));
        ?>
        <div class="wrap">
            <h1>Chitra AI Chat</h1>
            <p>Add your AI assistant chat widget to every page of this site.</p>
            <form method="post" action="options.php">
                <?php settings_fields('chitra_ai_chat'); ?>
                <table class="form-table">
                    <tr>
                        <th scope="row"><label for="chitra_org_id">Org ID</label></th>
                        <td>
                            <input name="chitra_org_id" id="chitra_org_id" type="text"
                                   value="<?php echo $org_id; ?>" class="regular-text"
                                   placeholder="e.g. 9f8c1a2b-..." />
                            <p class="description">Find it in your Chitra dashboard under “Install on your site”.</p>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="chitra_api_url">API URL</label></th>
                        <td>
                            <input name="chitra_api_url" id="chitra_api_url" type="url"
                                   value="<?php echo $api_url; ?>" class="regular-text" />
                            <p class="description">Your Chitra backend URL (default is fine for most users).</p>
                        </td>
                    </tr>
                </table>
                <?php submit_button('Save Settings'); ?>
            </form>
        </div>
        <?php
    }

    /** Inject the widget loader into the footer when configured. */
    public function render_widget() {
        $org_id  = get_option('chitra_org_id');
        $api_url = untrailingslashit(get_option('chitra_api_url', 'https://api.chitratech.com.np'));
        if (!$org_id) return;

        printf(
            '<script src="%s/widget.js?org=%s" defer></script>',
            esc_url($api_url),
            esc_attr($org_id)
        );
    }
}

new Chitra_AI_Chat();
