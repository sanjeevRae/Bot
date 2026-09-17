<?php
/**
 * Chitra AI Chat — uninstall cleanup.
 * Removes the plugin's options when the plugin is deleted.
 */

if (!defined('WP_UNINSTALL_PLUGIN')) exit;

delete_option('chitra_org_id');
delete_option('chitra_api_url');
