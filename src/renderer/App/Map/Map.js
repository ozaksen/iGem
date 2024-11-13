import React, { useEffect, useState, useRef } from 'react';
import CustomMarker from "./CustomMarker";
import { DatePicker, Button, Layout, Row, Col, Slider, Drawer, FloatButton } from 'antd';
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  StepForwardOutlined,
  StepBackwardOutlined,
  SettingOutlined,
  AppstoreAddOutlined,
  ControlOutlined,
} from '@ant-design/icons';
import { MapContainer, TileLayer, Popup, LayersControl } from 'react-leaflet';
import circleRedMarker from '../Icons/circle_red_marker.png';
import squareRedMarker from '../Icons/square_red_marker.png';
import starRedMarker from '../Icons/star_red_marker.png';
import triangleRedMarker from '../Icons/triangle_red_marker.png';
import FileSelectionModal from '../Modals/FileSelectionModal';
import DeviceSelectionModal from '../Modals/DeviceSelectionModal';

const { Header } = Layout;
const { ipcRenderer } = window.require('electron'); // Import ipcRenderer for database fetching

export default function Map() {
  const [filteredLocations, setFilteredLocations] = useState([]);
  const [visibleLocations, setVisibleLocations] = useState([]);
  const [startDateTime, setStartDateTime] = useState(null);
  const [endDateTime, setEndDateTime] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const animationRef = useRef(null);
  const [index, setIndex] = useState(0);
  const [locations, setLocations] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [isDrawerVisible, setIsDrawerVisible] = useState(false);
  const [isFileModalVisible, setIsFileModalVisible] = useState(false);
  const [ktxFiles, setKtxFiles] = useState([]);
  const [matchedLocations , setMatchedLocations ] = useState([]);
  const [pngPath, setPngPath] = useState(null); // Store path to PNG image
  const [showLimitedPoints, setShowLimitedPoints] = useState(false); // State for checkbox

  const loadBase64Image = async (ktxFilePath) => {
    try {
      console.log(ktxFilePath)
      const base64Image = await ipcRenderer.invoke('convert-ktx-to-png', ktxFilePath);
      console.log(base64Image)
      setPngPath(base64Image); // Directly set base64 string in the img src
    } catch (error) {
      console.error('Error loading KTX file:', error);
    }
  };

  const matchKtxToLocations = (locations, ktxFiles) => {
    const matchedLocations = locations.map(location => {
      // Find the closest KTX file to the current location
      const closestKtxFile = ktxFiles
        .filter(file => file.deviceId === location.deviceId)
        .reduce((prev, curr) => {
          const prevDiff = Math.abs(location.timestamp - prev.timestamp);
          const currDiff = Math.abs(location.timestamp - curr.timestamp);
          return currDiff < prevDiff ? curr : prev;
        }, ktxFiles[0]);
      return {
        ...location,
        hasKtxFile: closestKtxFile && Math.abs(location.timestamp - closestKtxFile.timestamp) < 30000, // 1-minute threshold
        ktxObj: closestKtxFile
      };
    });
    console.log(matchedLocations)
    setMatchedLocations(
      matchedLocations.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    );    // setVisibleLocations(matchedLocations.slice(0, index + 1));
  };

  const getRedMarkerIcon = (iconShape) => {
    switch (iconShape) {
      case 'circle':
        return circleRedMarker;
      case 'square':
        return squareRedMarker;
      case 'star':
        return starRedMarker;
      case 'triangle':
        return triangleRedMarker;
      default:
        return circleRedMarker;
    }
  };

  const handleFileModalOpen = () => {
    setIsFileModalVisible(true);
  };

  const handleFileModalClose = () => {
    setIsFileModalVisible(false);
  };

  const handleFileConfirm = (file) => {
    console.log("File added:", file);
  };

  const onClose = () => {
    setIsDrawerVisible(false);
  };

  useEffect(() => {
    const fetchData = async () => {
      // Get device data from the backend
      const devicesResponse = await ipcRenderer.invoke('get-devices');
      const devices = devicesResponse.data;
    
      const allLocations = [];
      const allKtxFiles = [];
      let c = 1
      // Loop through each device to fetch its locations and .ktx files
      for (const device of devices) {
        const deviceLocationsResponse = await ipcRenderer.invoke('get-device-locations', device.id);
        const ktxFilesResponse = await ipcRenderer.invoke('get-ktx-files', device.id);
    
        if (deviceLocationsResponse.success && ktxFilesResponse.success) {
          const deviceLocations = deviceLocationsResponse.data.map(location => ({
            ...location,
            timestamp: new Date(location.timestamp),
            mapDeviceId: c,
            deviceId: device.id
          }));
    
          const deviceKtxFiles = ktxFilesResponse.data.map(file => ({
            ...file,
            timestamp: new Date(file.timestamp),
            deviceId: device.id,
          }));
    
          allLocations.push(...deviceLocations);
          allKtxFiles.push(...deviceKtxFiles);
        }
        c+=1
      }
    
      setLocations(allLocations);
      setKtxFiles(allKtxFiles);
      matchKtxToLocations(allLocations, allKtxFiles);
    };

    fetchData();
  }, []);

  useEffect(() => {
    if (showLimitedPoints) {
      const limitedLocations = matchedLocations.reduce((acc, location) => {
        const fileLocations = acc[location.deviceId] || [];
        if (fileLocations.length < 5) {
          acc[location.deviceId] = [...fileLocations, location];
        }
        return acc;
      }, {});

      setVisibleLocations(Object.values(limitedLocations).flat());
    } else {
      setVisibleLocations(filteredLocations);
    }
  }, [showLimitedPoints, filteredLocations]);

  const togglePlayPause = () => {
    if (isPlaying) {
      clearInterval(animationRef.current);
    } else {
      startAnimation();
    }
    setIsPlaying(!isPlaying);
  };

  const forward = () => {
    const newIndex = Math.min(index + 10, filteredLocations.length - 1);
    setIndex(newIndex);
    updateVisibleLocations(newIndex);
  };

  const backward = () => {
    const newIndex = Math.max(index - 10, 0);
    setIndex(newIndex);
    updateVisibleLocations(newIndex);
  };

  useEffect(() => {
    setVisibleLocations([])
    if (startDateTime && endDateTime) {
      const filtered = matchedLocations
        .filter((location) => Date.parse(location.timestamp) >= Date.parse(startDateTime) && Date.parse(location.timestamp) <= Date.parse(endDateTime))
        .sort((a, b) => a.timestamp - b.timestamp);
      console.log(filtered)
      setFilteredLocations(filtered);
    } else {
      setFilteredLocations([]);
    }
  }, [startDateTime, endDateTime, matchedLocations]);

  const startAnimation = () => {
    let currentIndex = index;
    animationRef.current = setInterval(() => {
      if (currentIndex < filteredLocations.length) {
        updateVisibleLocations(currentIndex);
        setIndex(currentIndex++);
      } else {
        clearInterval(animationRef.current);
      }
    }, 500);
  };

  const updateVisibleLocations = (newIndex) => {
    const recentLocations = filteredLocations.slice(0, newIndex + 1);
    setVisibleLocations(recentLocations);
  };

  const closeDrawer = () => {
    setIsDrawerVisible(false);
    setSelectedLocation(null);
  };

  const openDrawer = (location) => {
    setSelectedLocation(location);
    setIsDrawerVisible(true);
  };

  const currentTimestamp = filteredLocations[index]?.timestamp.toLocaleString() || "N/A";

  return (
    <div>
      <Layout>
        <Header style={{ height: '64px', width: '100%', backgroundColor: '#993955', position: 'relative' }}>
          <Row gutter={[16, 16]} align="middle">
            <Col>
              <DatePicker showTime value={startDateTime} onChange={(date) => setStartDateTime(date)} placeholder="Start DateTime" />
            </Col>
            <Col>
              <DatePicker showTime value={endDateTime} onChange={(date) => setEndDateTime(date)} placeholder="End DateTime" />
            </Col>
            <Col>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <Button onClick={backward} icon={<StepBackwardOutlined />} />
                <Button onClick={togglePlayPause} icon={isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />} />
                <Button onClick={forward} icon={<StepForwardOutlined />} />
                <Slider style={{ width: 100, marginLeft: 20 }} value={index} max={filteredLocations.length - 1} />
                <span style={{ marginLeft: '10px' }}>{index}/{filteredLocations.length || 1}</span>
              </div>
            </Col>
          </Row>
        </Header>
        <Layout>
          <MapContainer center={[40.454, -86.904]} zoom={13} style={{ height: 'calc(100vh - 64px)', width:'100vw' }}>
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <LayersControl position="topright">
              <LayersControl.Overlay checked name="GPS Locations">
                {visibleLocations.map((location, i) => (
                  <CustomMarker 
                    key={i} 
                    position={[location.latitude, location.longitude]} 
                    ktx={location.hasKtxFile}
                    mapDeviceId={location.mapDeviceId}
                  >
                    <Popup>
                      <div>
                        <p>Speed: {location.speed || 'N/A'} m/s</p>
                        <p>Timestamp: {location.timestamp.toLocaleString()}</p>
                        <p>Device Id: {location.mapDeviceId.toLocaleString()}</p>
                        { location.hasKtxFile &&
                        <>
                        <p>KTX Id: {location.ktxObj.filepath}</p>
                        <div>
                          <button onClick={() => loadBase64Image (location.ktxObj.filepath)}>Load KTX Image</button>
                          {pngPath && (
                              <img 
                                src={pngPath} 
                                alt="KTX Content" 
                                style={{ 
                                  maxWidth: '100%',  // Ensures the image doesn’t exceed the popup width
                                  maxHeight: '150px', // Adjusts the height to fit within the popup’s visible area
                                  objectFit: 'contain' // Scales the image while preserving aspect ratio
                                }} 
                              />
                            )}
                          </div>
                        </>
                        }

                                            
                        <Button type="link" onClick={() => openDrawer(location)}>More Info</Button>
                      </div>
                    </Popup>
                  </CustomMarker>
                ))}
              </LayersControl.Overlay>
            </LayersControl>
          </MapContainer>
          <div style={{
            position: 'absolute', top: '10px', right: '10px', backgroundColor: 'rgba(255, 255, 255, 0.8)',
            padding: '10px', borderRadius: '5px', fontSize: '14px', color: '#333'
          }}>
            <strong>Current Time: </strong>{currentTimestamp}
          </div>
          <Drawer title="More Information" placement="right" open={isDrawerVisible} width={400} onClose={onClose}>
            {selectedLocation ? (
              <div>
                <p><strong>Latitude:</strong> {selectedLocation.latitude}</p>
                <p><strong>Longitude:</strong> {selectedLocation.longitude}</p>
                <p><strong>Speed:</strong> {selectedLocation.speed || 'N/A'} m/s</p>
                <p><strong>Timestamp:</strong> {selectedLocation.timestamp.toLocaleString()}</p>
              </div>
            ) : (
              <p>No additional information available</p>
            )}
          </Drawer>
          <FloatButton.Group trigger="click" type="primary" style={{ insetInlineEnd: 24 }} icon={<SettingOutlined />}>
            <FloatButton icon={<ControlOutlined />}/>
            <FloatButton icon={<AppstoreAddOutlined />} onClick={handleFileModalOpen} />
          </FloatButton.Group>
          <DeviceSelectionModal
            visible={isFileModalVisible}
            onClose={handleFileModalClose}
            onConfirm={handleFileConfirm}
          />
        </Layout>
      </Layout>
    </div>
  );
}
