from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument('publish_rate', default_value='10.0'),
        DeclareLaunchArgument('nav_speed',    default_value='1.0'),
        DeclareLaunchArgument('port',         default_value='9090'),
        DeclareLaunchArgument('qr_id',        default_value='DEPOT'),

        Node(
            package='robot_sim',
            executable='pose_publisher',
            name='pose_publisher',
            parameters=[{
                'publish_rate': LaunchConfiguration('publish_rate'),
                'nav_speed':    LaunchConfiguration('nav_speed'),
                'qr_id':        LaunchConfiguration('qr_id'),
            }],
            output='screen',
        ),

        Node(
            package='rosbridge_server',
            executable='rosbridge_websocket',
            name='rosbridge_websocket',
            parameters=[{'port': LaunchConfiguration('port')}],
            output='screen',
        ),
    ])
