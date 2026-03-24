FROM journeykmutt/robot_simulator:latest

# Replace pose_publisher + launch file with navigation-aware versions
COPY pose_publisher.py /ros2_ws/src/robot_sim/robot_sim/pose_publisher.py
COPY sim.launch.py     /ros2_ws/src/robot_sim/launch/sim.launch.py

# Reinstall the package so the updated files are picked up
RUN bash -c "source /opt/ros/jazzy/setup.bash && \
    cd /ros2_ws && \
    colcon build --packages-select robot_sim 2>&1"
